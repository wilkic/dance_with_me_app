/**
 * Room music: who the host is (creator, back after a reconnect, the booked
 * DJ during their set), the room-music state, and WebRTC signalling
 * relayed only between a room's host and its members.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, scheduleFile: null, adminKey: 'k', log: () => {} });
await new Promise((r) => server.wss.on('listening', r));

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const c = { ws, id: null, inbox: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'welcome') c.id = m.id;
    c.inbox.push(m);
    for (const w of c.waiters.splice(0)) w();
  });
  ws.on('open', () => resolve(c));
});
const next = async (c, pred, ms = 2000) => {
  const until = Date.now() + ms;
  for (;;) {
    const i = c.inbox.findIndex(pred);
    if (i >= 0) return c.inbox.splice(i, 1)[0];
    if (Date.now() > until) throw new Error(`timed out waiting (${pred})`);
    await new Promise((r) => { c.waiters.push(r); setTimeout(r, 50); });
  }
};
const quiet = async (c, pred, ms = 300) => {
  await new Promise((r) => setTimeout(r, ms));
  assert.equal(c.inbox.some(pred), false, `unexpected message (${pred})`);
};
const sendTo = (c, msg) => c.ws.send(JSON.stringify(msg));

await test('the creator is the host; joiners are not; only the host starts music', async () => {
  const a = await connect();
  const b = await connect();
  const c = await connect();
  await next(a, (m) => m.type === 'welcome');
  sendTo(a, { type: 'join', room: 'party', hostKey: 'key-a' });
  assert.equal((await next(a, (m) => m.type === 'joined')).host, true);
  sendTo(b, { type: 'join', room: 'party', hostKey: 'key-b' });
  assert.equal((await next(b, (m) => m.type === 'joined')).host, false);
  sendTo(c, { type: 'join', room: 'party' });
  await next(c, (m) => m.type === 'joined' && !m.host);

  sendTo(b, { type: 'room-music', on: true, label: 'not mine' });
  await quiet(b, (m) => m.type === 'room' && m.music);
  sendTo(a, { type: 'room-music', on: true, label: 'mix.mp3' });
  const room = await next(b, (m) => m.type === 'room' && m.music);
  assert.equal(room.music.label, 'mix.mp3');
  assert.equal(room.host, a.id);
  assert.equal(room.members.find((x) => x.host).id, a.id);

  // Signalling: host ↔ member both ways; member ↔ member never.
  sendTo(a, { type: 'rtc', to: b.id, data: { sdp: 'offer' } });
  assert.deepEqual((await next(b, (m) => m.type === 'rtc')).data, { sdp: 'offer' });
  sendTo(b, { type: 'rtc', to: a.id, data: { sdp: 'answer' } });
  assert.equal((await next(a, (m) => m.type === 'rtc')).from, b.id);
  sendTo(b, { type: 'rtc', to: c.id, data: { sdp: 'sneaky' } });
  await quiet(c, (m) => m.type === 'rtc');
  sendTo(a, { type: 'rtc', to: b.id, data: { big: 'x'.repeat(20_000) } });
  await quiet(b, (m) => m.type === 'rtc');

  // The host drops out: the music stops; back with the same key, host again.
  a.ws.close();
  const after = await next(b, (m) => m.type === 'room' && !m.members.some((x) => x.id === a.id));
  assert.equal(after.host, null);
  assert.equal(after.music, null);
  const a2 = await connect();
  sendTo(a2, { type: 'join', room: 'party', hostKey: 'key-a' });
  assert.equal((await next(a2, (m) => m.type === 'joined')).host, true);
  for (const x of [a2, b, c]) x.ws.close();
});

await test('during a booked set the DJ (booking token) is the host, not the creator', async () => {
  const { booking, token } = server.schedule.book({ dj: 'DJ Room', start: Date.now() + 5 * 60_000, minutes: 60 });
  server.schedule.approve(booking.id);
  const early = await connect();
  sendTo(early, { type: 'join', room: 'dj-room', hostKey: 'early-bird' });
  assert.equal((await next(early, (m) => m.type === 'joined')).host, false);
  const dj = await connect();
  sendTo(dj, { type: 'join', room: 'dj-room', hostKey: 'whatever', bookingToken: token });
  assert.equal((await next(dj, (m) => m.type === 'joined')).host, true);
  sendTo(early, { type: 'room-music', on: true, label: 'x' });
  sendTo(dj, { type: 'room-music', on: true, label: 'DJ set' });
  assert.equal((await next(early, (m) => m.type === 'room' && m.music)).music.label, 'DJ set');
  early.ws.close(); dj.ws.close();
});

server.close();
process.exit(failed ? 1 : 0);
