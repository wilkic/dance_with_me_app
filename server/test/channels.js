/**
 * Music channels (issue #34): the playlist clock, the lobby listing, a
 * channel room's music and tempo, nobody hosts it, and the /music/ files
 * (Range requests, nothing outside the folder, no playlist file); a
 * resident DJ's daily set on the schedule, and its name can't be booked.
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
    { id: 'fast', name: 'Fast One', bpm: [160, 178], seconds: 60, tracks: [{ file: 'fast/c.opus', sec: 60, bpm: 170 }],
      daily: { at: '10:00', minutes: 120, tz: 'Europe/Brussels' }, setInfo: 'Fast all day.', bio: 'Resident.',
      set: { tracks: [{ file: 'slow/a.opus', sec: 1000, bpm: 126 }, { file: 'slow/b.opus', sec: 3000, bpm: 130 }] } },
    { id: 'open', name: 'Open Mix', always: true, seconds: 300, setInfo: 'Always on.', bio: 'The open room.',
      tracks: [{ file: 'slow/a.opus', sec: 100, bpm: 80 }, { file: 'slow/b.opus', sec: 200, bpm: 88 }] },
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

await test('a resident: a daily set in its own time zone, today until it ends, then tomorrow', () => {
  const ch = new Channels(dir);
  const ids = (t) => ch.residentSets(t).filter((x) => x.daily).map((x) => [x.id, new Date(x.start).toISOString()]);
  // Winter: 10:00 in Brussels is 09:00 UTC; summer: 08:00 UTC.
  assert.deepEqual(ids(Date.parse('2026-11-23T08:00:00Z')), [['fast-2026-11-23', '2026-11-23T09:00:00.000Z'], ['fast-2026-11-24', '2026-11-24T09:00:00.000Z']]);
  assert.equal(ids(Date.parse('2026-11-23T10:59:00Z'))[0][0], 'fast-2026-11-23'); // still on
  assert.deepEqual(ids(Date.parse('2026-11-23T11:00:00Z')).map((x) => x[0]), ['fast-2026-11-24', 'fast-2026-11-25']);
  assert.equal(ids(Date.parse('2026-07-01T07:00:00Z'))[0][1], '2026-07-01T08:00:00.000Z');
  assert.equal(ids(Date.parse('2026-12-31T12:00:00Z'))[0][0], 'fast-2027-01-01'); // over the year end
  const b = ch.residentSets(Date.parse('2026-11-23T08:00:00Z')).find((x) => x.daily);
  assert.deepEqual([b.dj, b.room, b.minutes, b.status, b.resident, b.daily, b.setInfo, b.token], ['Fast One', 'fast', 120, 'approved', true, true, 'Fast all day.', undefined]);
});

await test('an always-on resident: one schedule entry, on all the time, no set', () => {
  const ch = new Channels(dir);
  for (const t of [Date.parse('2026-11-23T01:00:00Z'), Date.parse('2026-11-23T09:30:00Z'), Date.parse('2030-06-01T12:00:00Z')]) {
    const open = ch.residentSets(t).filter((x) => x.room === 'open');
    assert.equal(open.length, 1);
    assert.deepEqual([open[0].id, open[0].dj, open[0].always, open[0].resident, open[0].status, open[0].setInfo], ['open-always', 'Open Mix', true, true, 'approved', 'Always on.']);
    assert.ok(open[0].start <= t && open[0].start + open[0].minutes * 60_000 > t);
    assert.equal(ch.at('open', t).set, false);
  }
});

await test('a resident plays its set during the slot, from the top; all its tracks the rest of the day', () => {
  const ch = new Channels(dir);
  const slot = Date.parse('2026-11-23T09:00:00Z'); // 10:00 in Brussels
  const before = ch.at('fast', slot - 1000);
  assert.equal(before.track.file, 'fast/c.opus');
  assert.equal(before.set, false);
  const first = ch.at('fast', slot);
  assert.deepEqual([first.track.file, first.start, first.set, first.next.file], ['slow/a.opus', slot, true, 'slow/b.opus']);
  const later = ch.at('fast', slot + 1500_000);
  assert.deepEqual([later.track.file, later.start, later.track.bpm], ['slow/b.opus', slot + 1000_000, 130]);
  assert.equal(ch.at('fast', slot + 4000_000 + 10).track.file, 'slow/a.opus'); // the set loops within the slot
  assert.equal(ch.at('fast', slot + 120 * 60_000).track.file, 'fast/c.opus'); // 12:00: back to all day
  assert.equal(ch.music('fast', slot + 60_000).src, '/music/slow/a.opus');
  assert.equal(ch.at('slow', slot).set, false); // no daily slot: never a set
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
  assert.deepEqual(chans.map((r) => [r.name, r.title, r.dancers]), [['slow', 'Slow One', 0], ['fast', 'Fast One', 0], ['open', 'Open Mix', 0]]);
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

await test('the schedule lists the resident set and the open room; nobody can book its name', async () => {
  const a = await connect();
  const sched = await next(a, (m) => m.type === 'schedule');
  const res = sched.bookings.filter((x) => x.resident && x.daily);
  assert.equal(res.length, 2);
  assert.ok(res.every((x) => x.room === 'fast' && x.dj === 'Fast One' && !x.token));
  const open = sched.bookings.filter((x) => x.always);
  assert.deepEqual(open.map((x) => [x.room, x.dj]), [['open', 'Open Mix']]);
  assert.equal(sched.bookings[0].room, 'open'); // listed first
  sendTo(a, { type: 'book', dj: 'Fast One', start: Date.now() + 86_400_000, minutes: 60 });
  const err = await next(a, (m) => m.type === 'error');
  assert.match(err.message ?? err.error ?? JSON.stringify(err), /Fast One’s room/);
  a.ws.close();
});

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
