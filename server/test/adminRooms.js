/**
 * Admin room controls (acting on reports, see /terms/): admins see live
 * rooms, can stop a room's music for good and end a room; ended names
 * stay closed. Nobody else can.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, scheduleFile: null, statsFile: null, adminKey: 'k', log: () => {} });
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

await test('admin sees live rooms; a non-admin cannot stop music or end rooms', async () => {
  const host = await connect();
  const guest = await connect();
  const admin = await connect();
  sendTo(host, { type: 'join', room: 'loud', hostKey: 'h' });
  await next(host, (m) => m.type === 'joined' && m.host);
  sendTo(guest, { type: 'join', room: 'loud' });
  await next(guest, (m) => m.type === 'joined');
  sendTo(host, { type: 'room-music', on: true, label: 'track.mp3' });
  await next(guest, (m) => m.type === 'room' && m.music?.label === 'track.mp3');

  sendTo(guest, { type: 'stop-music', room: 'loud' });
  sendTo(guest, { type: 'end-room', room: 'loud' });
  await quiet(host, (m) => m.type === 'music-stopped' || m.type === 'room-ended');

  sendTo(admin, { type: 'admin', key: 'wrong' });
  await next(admin, (m) => m.type === 'error' && m.for === 'admin');
  await quiet(admin, (m) => m.type === 'live-rooms');
  sendTo(admin, { type: 'admin', key: 'k' });
  const live = await next(admin, (m) => m.type === 'live-rooms');
  assert.deepEqual(live.rooms.find((r) => r.name === 'loud'), { name: 'loud', dancers: 2, music: 'track.mp3', silenced: false, live: false });
  host.ws.close(); guest.ws.close(); admin.ws.close();
});

await test('stop-music: the host is told, music stays off until the room closes', async () => {
  const host = await connect();
  const guest = await connect();
  const admin = await connect();
  sendTo(admin, { type: 'admin', key: 'k' });
  await next(admin, (m) => m.type === 'live-rooms');
  sendTo(host, { type: 'join', room: 'quiet-please', hostKey: 'h2' });
  await next(host, (m) => m.type === 'joined' && m.host);
  sendTo(guest, { type: 'join', room: 'quiet-please' });
  await next(guest, (m) => m.type === 'joined');
  sendTo(host, { type: 'room-music', on: true, label: 'x.mp3' });
  await next(guest, (m) => m.type === 'room' && m.music);

  sendTo(admin, { type: 'stop-music', room: 'quiet-please' });
  await next(host, (m) => m.type === 'music-stopped');
  await next(guest, (m) => m.type === 'room' && !m.music);
  const live = await next(admin, (m) => m.type === 'live-rooms' && m.rooms.some((r) => r.name === 'quiet-please' && r.silenced));
  assert.equal(live.rooms.find((r) => r.name === 'quiet-please').music, null);

  // Trying again: refused, and no signalling gets through.
  guest.inbox.length = 0;
  sendTo(host, { type: 'room-music', on: true, label: 'again.mp3' });
  await next(host, (m) => m.type === 'music-stopped');
  sendTo(host, { type: 'rtc', to: guest.id, data: { sdp: { type: 'offer', sdp: 'v=0' } } });
  await quiet(guest, (m) => m.type === 'rtc' || (m.type === 'room' && m.music));
  host.ws.close(); guest.ws.close(); admin.ws.close();
});

await test('end-room: everyone is sent back to solo, the name stays closed', async () => {
  const a = await connect();
  const b = await connect();
  const admin = await connect();
  sendTo(admin, { type: 'admin', key: 'k' });
  await next(admin, (m) => m.type === 'live-rooms');
  sendTo(a, { type: 'join', room: 'trouble', hostKey: 'ha' });
  await next(a, (m) => m.type === 'joined');
  sendTo(b, { type: 'join', room: 'trouble' });
  await next(b, (m) => m.type === 'joined');

  sendTo(admin, { type: 'end-room', room: 'trouble' });
  await next(a, (m) => m.type === 'room-ended');
  await next(b, (m) => m.type === 'room-ended');
  await next(admin, (m) => m.type === 'live-rooms' && !m.rooms.some((r) => r.name === 'trouble'));
  await next(a, (m) => m.type === 'rooms' && !m.rooms.some((r) => r.name === 'trouble'));

  sendTo(b, { type: 'join', room: 'Trouble' });
  const err = await next(b, (m) => m.type === 'error' && m.for === 'join');
  assert.match(err.error, /closed/);
  sendTo(b, { type: 'join', room: 'other-room' });
  await next(b, (m) => m.type === 'joined' && m.room === 'other-room');
  a.ws.close(); b.ws.close(); admin.ws.close();
});

server.close();
process.exit(failed ? 1 : 0);
