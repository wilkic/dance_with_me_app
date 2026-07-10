/**
 * End-to-end synthetic test: start the server, connect two WebSocket
 * clients streaming synthetic PoseFrames "dancing" at 120 and 118 BPM,
 * and assert the server profiles both near 120 and matches them with a
 * tempo-appropriate song.
 *
 * Synthesis note: motion energy is joint *speed*, so a joint oscillating
 * at 1 Hz produces two energy peaks per cycle → 2 Hz → 120 BPM.
 */
import WebSocket from 'ws';
import { startServer } from '../index.js';
import { serializePoseFrame, emptyPoseFrame, KP, STRIDE } from '../../src/pose/poseFormat.js';

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
    const dancer = { bpm, ws, id: null, profile: null, match: null };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString());
      if (msg.type === 'welcome') {
        dancer.id = msg.id;
        resolve(dancer);
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

for (const d of dancers) d.ws.close();
server.close();
process.exit(failed ? 1 : 0);
