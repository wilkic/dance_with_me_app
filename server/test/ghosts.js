/**
 * Ghost members: a phone that reconnects (screen sleep, network blip)
 * joins again from a new connection while its old one may never close.
 * The rejoin replaces the old connection, the heartbeat drops connections
 * that stopped answering, and only members whose frames arrive count as
 * dancing.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';
import { makeDancer } from '../lab/synthDancer.js';
import { serializePoseFrame } from '../../src/pose/poseFormat.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

const opts = { port: 0, scanIntervalMs: 200, library: false, recordDir: null, scheduleFile: null, statsFile: null, adminKey: 'k', log: () => {} };
const slow = startServer({ ...opts, heartbeatMs: 60_000 }); // only the tab rule can drop anyone
const fast = startServer({ ...opts, heartbeatMs: 400 });
await Promise.all([slow, fast].map((sv) => new Promise((r) => sv.wss.on('listening', r))));
let server = slow;

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
const members = (c) => c.last.room?.members ?? [];

await test('a tab that reconnects replaces its old connection (no ghost)', async () => {
  const a = await connect();
  const phone = await connect();
  sendTo(a, { type: 'join', room: 'g1', tab: 'tab-a' });
  sendTo(phone, { type: 'join', room: 'g1', tab: 'tab-p' });
  assert.ok(await until(() => members(a).length === 2), 'both in');
  // The phone's network drops: its socket goes silent but never closes.
  phone.ws._socket.pause();
  await wait(3200); // longer than QUIET_MS
  const again = await connect();
  sendTo(again, { type: 'join', room: 'g1', tab: 'tab-p' });
  assert.ok(await until(() => members(a).length === 2 && members(a).some((m) => m.id === again.id), 1500),
    `room: ${members(a).map((m) => m.id)}`);
  for (const c of [a, phone, again]) c.ws.terminate();
});

await test('a duplicated tab that is still active is not kicked', async () => {
  const one = await connect();
  const two = await connect();
  sendTo(one, { type: 'join', room: 'g2', tab: 'same' });
  sendTo(two, { type: 'join', room: 'g2', tab: 'same' });
  assert.ok(await until(() => members(one).length === 2), 'both stay');
  for (const c of [one, two]) c.ws.terminate();
});

await test('heartbeat: a connection that stops answering leaves its room', async () => {
  server = fast;
  const a = await connect();
  const dead = await connect();
  sendTo(a, { type: 'join', room: 'g3' });
  sendTo(dead, { type: 'join', room: 'g3' });
  assert.ok(await until(() => members(a).length === 2), 'both in');
  dead.ws._socket.pause(); // no pongs
  assert.ok(await until(() => members(a).length === 1, 3000), 'still in the room');
  for (const c of [a, dead]) c.ws.terminate();
});

await test('only members whose frames arrive count as dancing', async () => {
  const a = await connect();
  const b = await connect();
  sendTo(a, { type: 'join', room: 'g4' });
  sendTo(b, { type: 'join', room: 'g4' });
  assert.ok(await until(() => members(a).length === 2), 'both in');
  assert.equal(members(a).find((m) => m.id === b.id).dancing, false);
  const d = makeDancer({ parts: { arms: { hz: 1, amp: 0.1 } } });
  for (let t = 0; t <= 1000; t += 33) b.ws.send(serializePoseFrame(d.frameAt(t)));
  assert.ok(await until(() => members(a).find((m) => m.id === b.id)?.dancing === true), 'b never dancing');
  for (const c of [a, b]) c.ws.terminate();
});

slow.close();
fast.close();
if (failed) { console.log(`${failed} ghost test(s) failed`); process.exit(1); }
console.log('all ghost tests passed');
