/**
 * Where a dancer's beat comes from: movement only once it has locked
 * (walking up to the phone is not dancing), and the room's music — as
 * measured by the phones playing it — over everyone's movement.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';
import { BeatDetector } from '../beatDetector.js';
import { makeDancer } from '../lab/synthDancer.js';
import { serializePoseFrame } from '../../src/pose/poseFormat.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

/**
 * 0–4 s: walking up to the phone (the whole body drifts, slowing down);
 * 4–10 s: standing, a little pose-detector wobble; from 10 s: an arm wave
 * at `bpm`.
 */
function arrival(bpm, endMs) {
  const still = makeDancer({ parts: {}, noise: 0.0015 });
  const dance = makeDancer({ parts: { arms: { hz: bpm / 120, amp: 0.1 } }, noise: 0.0015 });
  const frames = [];
  for (let t = 0; t <= endMs; t += 33) {
    const f = (t < 10_000 ? still : dance).frameAt(t);
    if (t < 4000) {
      const k = 1 - t / 4000; // slowing down as they arrive
      const dx = 0.25 * k * k + 0.03 * Math.sin(t / 90) * k;
      const dy = 0.1 * k * k * k;
      for (let i = 0; i < f.keypoints.length; i += 4) { f.keypoints[i] += dx; f.keypoints[i + 1] += dy; }
    }
    frames.push(f);
  }
  return frames;
}

await test('movement tempo: nothing while arriving and standing, locks once dancing', async () => {
  const det = new BeatDetector();
  let firstAt = 0;
  let warmed = false;
  for (const f of arrival(120, 30_000)) {
    const st = det.update(f);
    if (st.bpm > 0 && !firstAt) firstAt = f.t;
    if (f.t > 10_000 && !st.bpm && st.warming) warmed = true;
  }
  assert.ok(firstAt > 10_000, `a tempo before the dancing started (at ${firstAt} ms)`);
  assert.ok(firstAt < 19_000, `locked late (${firstAt} ms)`);
  assert.ok(warmed, 'never said it was warming up');
  assert.ok(Math.abs(det.state.bpm - 120) < 6, `settled at ${det.state.bpm}`);
});

await test('library clips (lock: false) are rated from the first estimate', async () => {
  const frames = makeDancer({ parts: { arms: { hz: 1, amp: 0.1 } } }).frames(8);
  const locked = new BeatDetector();
  const free = new BeatDetector({ lock: false });
  let tLocked = 0;
  let tFree = 0;
  for (const f of frames) {
    if (locked.update(f).bpm && !tLocked) tLocked = f.t;
    if (free.update(f).bpm && !tFree) tFree = f.t;
  }
  assert.ok(tFree > 0 && tFree < tLocked, `free ${tFree} ms, locked ${tLocked} ms`);
});

// ---- Room music over the wire ----

const server = startServer({ port: 0, scanIntervalMs: 250, library: false, recordDir: null, scheduleFile: null, statsFile: null, adminKey: 'k', log: () => {} });
await new Promise((r) => server.wss.on('listening', r));

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const c = { ws, id: null, last: {} };
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(d.toString());
    if (m.type === 'welcome') c.id = m.id;
    c.last[m.type] = m;
  });
  ws.on('open', () => resolve(c));
});
const sendTo = (c, msg) => c.ws.send(JSON.stringify(msg));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await wait(50); }
  return false;
};
/** Onset envelope of a click track: what a phone playing music at `bpm` sends. */
const clicks = (bpm, seconds, extra = {}) => {
  for (let b = 0; b < seconds; b++) {
    const e = Array.from({ length: 30 }, (_, i) => ((((b * 30 + i) / 30) * bpm / 60) % 1) < 0.15 ? 1 : 0.05);
    extra.to.ws.send(JSON.stringify({ type: 'music', from: 'room', t0: b * 1000, hz: 30, e }));
  }
};
/** Dance at `bpm` for `ms` of pose time (sent as fast as the socket allows). */
const dance = (c, bpm, ms) => {
  const d = makeDancer({ parts: { arms: { hz: bpm / 120, amp: 0.1 } } });
  for (let t = 0; t <= ms; t += 33) c.ws.send(serializePoseFrame(d.frameAt(t)));
};

const host = await connect();
const a = await connect();
const b = await connect();
await until(() => host.id && a.id && b.id);
sendTo(host, { type: 'join', room: 'beat', hostKey: 'h' });
await wait(100);
sendTo(a, { type: 'join', room: 'beat' });
sendTo(b, { type: 'join', room: 'beat' });
await wait(100);

await test('room music: no music in the room, envelopes from it are ignored', async () => {
  clicks(128, 6, { to: a });
  await wait(600);
  assert.equal(b.last.profile?.musicBpm ?? 0, 0);
  assert.equal(b.last.room?.bpm ?? 0, 0);
});

await test('room music: one listener measures it, the whole room (and the lobby) has its tempo', async () => {
  sendTo(host, { type: 'room-music', on: true, label: 'mix.mp3' });
  clicks(128, 8, { to: a });
  assert.ok(await until(() => Math.abs((b.last.profile?.musicBpm ?? 0) - 128) < 3), `b hears ${b.last.profile?.musicBpm}`);
  assert.ok(Math.abs((host.last.profile?.musicBpm ?? 0) - 128) < 3, `host hears ${host.last.profile?.musicBpm}`);
  assert.equal(b.last.profile.bpm, 0, 'b has not danced: no movement tempo');
  assert.ok(await until(() => Math.abs((b.last.room?.bpm ?? 0) - 128) < 3), `room at ${b.last.room?.bpm}`);
  assert.ok(Math.abs((b.last.rooms?.rooms.find((r) => r.name === 'beat')?.bpm ?? 0) - 128) < 3, 'lobby');
});

await test('room music: pairing uses the music, not movement at clashing tempi', async () => {
  // 100 and 140 are no match on their own; both dance to the room's 128.
  dance(a, 100, 9000);
  dance(b, 140, 9000);
  clicks(128, 2, { to: a });
  assert.ok(await until(() => a.last.match && b.last.match), `not matched: ${JSON.stringify({ a: a.last.profile, b: b.last.profile, g: server.sessions.get(a.id)?.lastFrameAt })}`);
  assert.equal(a.last.match.partner, b.id);
  assert.ok(Math.abs(a.last.match.bpm - 128) < 3, `matched at ${a.last.match.bpm}`);
});

await test('room music: stopped, the room falls back to movement', async () => {
  sendTo(host, { type: 'room-music', on: false });
  assert.ok(await until(() => (b.last.profile?.musicBpm ?? 1) === 0), `still hears ${b.last.profile?.musicBpm}`);
});

for (const c of [host, a, b]) c.ws.close();
server.close();
if (failed) { console.log(`${failed} tempo test(s) failed`); process.exit(1); }
console.log('all tempo tests passed');
