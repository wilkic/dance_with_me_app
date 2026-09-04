/**
 * End-to-end synthetic test: start the server, connect two WebSocket
 * clients streaming synthetic PoseFrames "dancing" at 120 and 118 BPM,
 * in the same dance room, and assert the server profiles both near 120,
 * relays each one's frames to the other, reports the room tempo, and
 * matches them with a tempo-appropriate song.
 *
 * Synthesis note: motion energy is joint *speed*, so a joint oscillating
 * at 1 Hz produces two energy peaks per cycle → 2 Hz → 120 BPM.
 */
import WebSocket from 'ws';
import { startServer } from '../index.js';
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
    const dancer = { bpm, ws, id: null, profile: null, match: null, room: null, relayed: new Map() };
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
      } else if (msg.type === 'profile') {
        dancer.profile = msg;
      } else if (msg.type === 'match') {
        dancer.match = msg;
      }
    });
    ws.on('error', reject);
  });
}

const server = startServer({ port: 0, scanIntervalMs: 500 });
await new Promise((r) => server.wss.on('listening', r));
console.log(`server on port ${server.port}`);

const dancers = await Promise.all([
  connectDancer(server.port, 120),
  connectDancer(server.port, 118),
]);

// Stream 15 virtual seconds of dancing at ~30 fps (frame.t is synthetic,
// so this can be sent as fast as the socket allows).
for (const d of dancers) {
  for (let t = 0; t <= 15000; t += 33) {
    d.ws.send(serializePoseFrame(makeFrame(t, d.bpm)));
  }
}

// Wait for opinion scans to run on the streamed data.
const deadline = Date.now() + 5000;
while (Date.now() < deadline && !dancers.every((d) => d.match)) {
  await new Promise((r) => setTimeout(r, 100));
}

let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed = true;
};

for (const d of dancers) {
  const bpm = d.profile?.bpm ?? 0;
  check(
    `dancer@${d.bpm}: profiled ${bpm.toFixed(1)} bpm (conf ${d.profile?.confidence?.toFixed(2)})`,
    Math.abs(bpm - d.bpm) < 6 && d.profile.confidence > 0.3,
  );
  check(
    `dancer@${d.bpm}: matched with ${d.match?.partner} → "${d.match?.song?.title}" (${d.match?.song?.bpm} bpm)`,
    !!d.match && Math.abs(d.match.song.bpm - 119) < 15,
  );
}
check(
  'dancers matched with each other',
  dancers[0].match?.partner === dancers[1].id && dancers[1].match?.partner === dancers[0].id,
);

// ---- Dance room checks ----
const [d0, d1] = dancers;
// ---- Lobby checks: the start screen's room list ----
const lob = d0.lobby?.find((r) => r.name === 'test-floor');
check(
  `lobby: lists test-floor with ${lob?.dancers} dancing at ${lob?.bpm?.toFixed?.(1)} bpm`,
  d0.lobby?.length === 1 && lob?.dancers === 2 && Math.abs(lob.bpm - 119) < 6,
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
const nFrames = Math.floor(15000 / 33) + 1;
for (const [me, other] of [[d0, d1], [d1, d0]]) {
  const r = me.relayed.get(other.id);
  check(
    `room: dancer@${me.bpm} received ${r?.n ?? 0}/${nFrames} of dancer@${other.bpm}'s frames (last t=${r?.lastT})`,
    r?.n === nFrames && r.lastT === (nFrames - 1) * 33 && me.relayed.size === 1,
  );
}
check(
  `room: opinion lists both members with tempo (room ${d0.room?.bpm?.toFixed(1)} bpm)`,
  d0.room?.name === 'test-floor' && d0.room.members.length === 2 &&
  d0.room.members.some((m) => m.you && m.id === d0.id) &&
  d0.room.members.some((m) => !m.you && m.id === d1.id && Math.abs(m.bpm - 118) < 6) &&
  Math.abs(d0.room.bpm - 119) < 6,
);
// Leaving: the room shrinks for the one who stays.
d1.ws.send(JSON.stringify({ type: 'leave' }));
await new Promise((r) => setTimeout(r, 200));
check(
  'room: after one leaves, the other sees a room of one',
  d0.room?.members.length === 1 && d0.room.members[0].you,
);

for (const d of dancers) d.ws.close();
server.close();
process.exit(failed ? 1 : 0);
