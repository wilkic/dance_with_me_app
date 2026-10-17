/**
 * DJ schedule: booking validation, room clashes, cancel tokens, persistence,
 * and the book → broadcast round trip over a real server socket.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { Schedule } from '../schedule.js';
import { startServer } from '../index.js';
import { checkBooking, phase, joinable, OPEN_EARLY_MS } from '../../src/net/schedule.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
};
const NOW = Date.UTC(2026, 9, 17, 18, 0);
const H = 3_600_000;
const set = (over = {}) => ({ dj: 'DJ Funk', start: NOW + 2 * H, minutes: 60, setInfo: 'disco', bio: 'hi', ...over });

await test('bookings are validated and the room is the DJ name', () => {
  const { booking } = checkBooking(set({ dj: '  DJ   Funk ', link: 'example.com/dj' }), NOW);
  assert.equal(booking.dj, 'DJ Funk');
  assert.equal(booking.room, 'dj-funk');
  assert.equal(booking.link, 'https://example.com/dj');
  assert.match(checkBooking(set({ dj: '💃' }), NOW).error, /letters/);
  assert.match(checkBooking(set({ start: NOW - H }), NOW).error, /passed/);
  assert.match(checkBooking(set({ start: NOW + 100 * 24 * H }), NOW).error, /days ahead/);
  assert.match(checkBooking(set({ minutes: 5 }), NOW).error, /15 minutes/);
  assert.match(checkBooking(set({ start: 'soon' }), NOW).error, /date/);
  assert.equal(checkBooking(set({ bio: 'x'.repeat(5000) }), NOW).booking.bio.length, 1000);
});

await test('a set is joinable from 10 minutes before until it ends', () => {
  const b = { start: NOW, minutes: 60 };
  assert.equal(phase(b, NOW - OPEN_EARLY_MS - 1), 'upcoming');
  assert.equal(phase(b, NOW - OPEN_EARLY_MS), 'open');
  assert.equal(phase(b, NOW + 1), 'live');
  assert.equal(phase(b, NOW + H), 'over');
  assert.equal(joinable(b, NOW - 60_000), true);
  assert.equal(joinable(b, NOW + 2 * H), false);
});

await test('same room cannot be double-booked; other rooms can overlap', () => {
  const sch = new Schedule(null);
  assert.ok(sch.book(set(), NOW).token);
  assert.match(sch.book(set({ dj: 'dj funk', start: NOW + 2.5 * H }), NOW).error, /already has/);
  assert.ok(sch.book(set({ dj: 'DJ Funk', start: NOW + 3 * H }), NOW).booking); // right after
  assert.ok(sch.book(set({ dj: 'Other DJ' }), NOW).booking);
  assert.deepEqual(sch.list(NOW).map((b) => b.room), ['dj-funk', 'other-dj', 'dj-funk']);
  assert.equal(sch.list(NOW)[0].token, undefined); // never public
});

await test('only the token cancels; ended sets are dropped; bookings persist', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dance-sched-')), 'data', 'schedule.json');
  const sch = new Schedule(file);
  const a = sch.book(set(), NOW);
  const b = sch.book(set({ dj: 'Late', start: NOW + 10 * H }), NOW);
  assert.equal(sch.cancel(a.booking.id, 'wrong'), false);
  assert.equal(existsSync(file), true);
  const again = new Schedule(file);
  again.prune(NOW);
  assert.equal(again.list(NOW).length, 2);
  assert.equal(again.cancel(a.booking.id, a.token), true);
  assert.equal(again.prune(NOW + 11 * H + 1), true);
  assert.deepEqual(new Schedule(file).list(NOW), []);
  assert.ok(b.token);
});

await test('book over the socket: booked to the DJ, schedule to everyone', async () => {
  const server = startServer({ port: 0, library: false, recordDir: null, scheduleFile: null, log: () => {} });
  await new Promise((r) => server.wss.on('listening', r));
  const connect = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
    const c = { ws, inbox: [], waiters: [] };
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      c.inbox.push(m);
      for (const w of c.waiters.splice(0)) w();
    });
    ws.on('open', () => resolve(c));
  });
  const next = async (c, pred) => {
    for (;;) {
      const i = c.inbox.findIndex(pred);
      if (i >= 0) return c.inbox.splice(i, 1)[0];
      await new Promise((r) => c.waiters.push(r));
    }
  };
  const dj = await connect();
  const fan = await connect();
  await next(fan, (m) => m.type === 'schedule');
  dj.ws.send(JSON.stringify({ type: 'book', ...set({ start: Date.now() + H }) }));
  const ok = await next(dj, (m) => m.type === 'booked');
  assert.equal(ok.booking.room, 'dj-funk');
  const seen = await next(fan, (m) => m.type === 'schedule' && m.bookings.length === 1);
  assert.equal(seen.bookings[0].dj, 'DJ Funk');
  dj.ws.send(JSON.stringify({ type: 'book', ...set({ start: Date.now() + H }) }));
  assert.match((await next(dj, (m) => m.type === 'error')).error, /already has/);
  dj.ws.send(JSON.stringify({ type: 'cancel', id: ok.booking.id, token: ok.token }));
  await next(dj, (m) => m.type === 'cancelled');
  await next(fan, (m) => m.type === 'schedule' && m.bookings.length === 0);
  dj.ws.close(); fan.ws.close();
  server.close();
});

process.exit(failed ? 1 : 0);
