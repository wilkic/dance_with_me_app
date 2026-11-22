/**
 * Music channels (issue #34): the playlist clock, the lobby listing, a
 * channel room's music and tempo, nobody hosts it, and the /music/ files
 * (Range requests, nothing outside the folder, no playlist file).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';
import { Channels } from '../channels.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

// A music folder: two channels, three made-up "tracks".
const dir = mkdtempSync(join(tmpdir(), 'dwm-channels-'));
mkdirSync(join(dir, 'slow'));
mkdirSync(join(dir, 'fast'));
writeFileSync(join(dir, 'slow', 'a.opus'), Buffer.alloc(1000, 1));
writeFileSync(join(dir, 'slow', 'b.opus'), Buffer.alloc(500, 2));
writeFileSync(join(dir, 'fast', 'c.opus'), Buffer.alloc(300, 3));
writeFileSync(join(dir, 'credits.html'), '<h1>credits</h1>');
writeFileSync(join(dir, 'secret.txt'), 'no');
writeFileSync(join(dir, 'channels.json'), JSON.stringify({
  channels: [
    { id: 'slow', name: 'Slow One', bpm: [70, 90], seconds: 300, tracks: [{ file: 'slow/a.opus', sec: 100, bpm: 80 }, { file: 'slow/b.opus', sec: 200, bpm: 88 }] },
    { id: 'fast', name: 'Fast One', bpm: [160, 178], seconds: 60, tracks: [{ file: 'fast/c.opus', sec: 60, bpm: 170 }] },
  ],
}));

await test('the clock: the playlist loops from the epoch, the same answer for everyone', () => {
  const ch = new Channels(dir);
  const epoch = Date.UTC(2026, 0, 1);
  const loop = 300_000;
  const t = epoch + 7 * loop + 150_000; // 150 s into a loop: the second track, 50 s in
  const at = ch.at('slow', t);
  assert.equal(at.track.file, 'slow/b.opus');
  assert.equal(t - at.start, 50_000);
  assert.equal(at.next.file, 'slow/a.opus');
  assert.equal(ch.at('slow', epoch + 7 * loop + 99_999).track.file, 'slow/a.opus');
  const m = ch.music('slow', t);
  assert.deepEqual([m.label, m.channel, m.bpm, m.src, m.next, m.now], ['Slow One', 'slow', 88, '/music/slow/b.opus', '/music/slow/a.opus', t]);
  assert.equal(ch.at('nope'), null);
  assert.equal(new Channels(join(dir, 'missing')).list.length, 0);
});

const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, scheduleFile: null, statsFile: null, keysDir: null, adminKey: 'k', musicDir: dir, log: () => {} });
await new Promise((r) => server.wss.on('listening', r));
const base = `http://127.0.0.1:${server.port}`;

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const c = { ws, inbox: [], waiters: [] };
  ws.on('message', (d) => {
    c.inbox.push(JSON.parse(d.toString()));
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
const sendTo = (c, msg) => c.ws.send(JSON.stringify(msg));

await test('the lobby lists every channel, even with nobody in it', async () => {
  const a = await connect();
  const lobby = await next(a, (m) => m.type === 'rooms');
  const chans = lobby.rooms.filter((r) => r.channel);
  assert.deepEqual(chans.map((r) => [r.name, r.title, r.dancers]), [['slow', 'Slow One', 0], ['fast', 'Fast One', 0]]);
  assert.ok(chans[0].bpm === 80 || chans[0].bpm === 88);
  a.ws.close();
});

await test('in a channel: its music and tempo, nobody hosts, room-music is ignored', async () => {
  const a = await connect();
  const b = await connect();
  sendTo(a, { type: 'join', room: 'fast', hostKey: 'key-a' });
  assert.equal((await next(a, (m) => m.type === 'joined')).host, false);
  const room = await next(a, (m) => m.type === 'room');
  assert.equal(room.host, null);
  assert.equal(room.music.channel, 'fast');
  assert.equal(room.music.src, '/music/fast/c.opus');
  assert.equal(room.bpm, 170);
  sendTo(b, { type: 'join', room: 'fast' });
  await next(b, (m) => m.type === 'room' && m.members.length === 2);
  sendTo(a, { type: 'room-music', on: true, label: 'my mix' });
  sendTo(a, { type: 'join', room: 'fast' });
  const again = await next(a, (m) => m.type === 'room' && m.members.length === 2);
  assert.equal(again.music.label, 'Fast One');
  const lobby = await next(b, (m) => m.type === 'rooms' && m.rooms.some((r) => r.name === 'fast' && r.dancers === 2));
  assert.equal(lobby.rooms.filter((r) => r.name === 'fast').length, 1);
  a.ws.close();
  b.ws.close();
});

await test('an admin can silence a channel: no music, no tempo', async () => {
  const a = await connect();
  const admin = await connect();
  sendTo(a, { type: 'join', room: 'slow' });
  await next(a, (m) => m.type === 'room' && m.music);
  sendTo(admin, { type: 'admin', key: 'k' });
  await next(admin, (m) => m.type === 'live-rooms');
  sendTo(admin, { type: 'stop-music', room: 'slow' });
  const room = await next(a, (m) => m.type === 'room' && !m.music);
  assert.equal(room.bpm, 0);
  a.ws.close();
  admin.ws.close();
});

await test('/music/: whole files, Range requests, CORS; nothing else', async () => {
  const whole = await fetch(`${base}/music/slow/a.opus`);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'audio/ogg');
  assert.equal(whole.headers.get('access-control-allow-origin'), '*');
  assert.equal((await whole.arrayBuffer()).byteLength, 1000);
  const part = await fetch(`${base}/music/slow/a.opus`, { headers: { Range: 'bytes=900-' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), 'bytes 900-999/1000');
  assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${base}/music/credits.html`)).status, 200);
  for (const bad of ['/music/channels.json', '/music/secret.txt', '/music/../channels.js', '/music/%2e%2e/channels.js', '/music/nope.opus']) {
    assert.equal((await fetch(base + bad)).status, 404, bad);
  }
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
