/**
 * Where a dancer's tempo comes from: only music. In a room, the room's
 * music as measured by the phones playing it; alone, the music they play
 * for themselves. Never their movement.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

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
    extra.to.ws.send(JSON.stringify({ type: 'music', t0: b * 1000, hz: 30, e }));
  }
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
  assert.equal(b.last.tempo?.bpm ?? 0, 0);
  assert.equal(b.last.room?.bpm ?? 0, 0);
});

await test('room music: one listener measures it, the whole room (and the lobby) has its tempo', async () => {
  sendTo(host, { type: 'room-music', on: true, label: 'mix.mp3' });
  clicks(128, 8, { to: a });
  assert.ok(await until(() => Math.abs((b.last.tempo?.bpm ?? 0) - 128) < 3), `b hears ${b.last.tempo?.bpm}`);
  assert.ok(Math.abs((host.last.tempo?.bpm ?? 0) - 128) < 3, `host hears ${host.last.tempo?.bpm}`);
  assert.ok(await until(() => Math.abs((b.last.room?.bpm ?? 0) - 128) < 3), `room at ${b.last.room?.bpm}`);
  assert.ok(Math.abs((b.last.rooms?.rooms.find((r) => r.name === 'beat')?.bpm ?? 0) - 128) < 3, 'lobby');
});

await test('room music: stopped, the room has no tempo', async () => {
  sendTo(host, { type: 'room-music', on: false });
  assert.ok(await until(() => (b.last.tempo?.bpm ?? 1) === 0 && b.last.room?.bpm === 0), `still hears ${b.last.tempo?.bpm}`);
});

await test('alone: the music you play for yourself is your tempo; nobody else gets it', async () => {
  const solo = await connect();
  const other = await connect();
  await until(() => solo.id && other.id);
  clicks(100, 8, { to: solo });
  assert.ok(await until(() => Math.abs((solo.last.tempo?.bpm ?? 0) - 100) < 3), `solo hears ${solo.last.tempo?.bpm}`);
  await wait(400);
  assert.equal(other.last.tempo?.bpm ?? 0, 0);
  for (const c of [solo, other]) c.ws.close();
});

for (const c of [host, a, b]) c.ws.close();
server.close();
if (failed) { console.log(`${failed} tempo test(s) failed`); process.exit(1); }
console.log('all tempo tests passed');
