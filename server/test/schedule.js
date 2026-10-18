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
const NOW = Math.floor(Date.now() / 60_000) * 60_000; // the file reload prunes by the real clock
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

await test('requests wait for approval and only approved sets are public', () => {
  const sch = new Schedule(null);
  const a = sch.book(set(), NOW);
  assert.equal(a.booking.status, 'pending');
  assert.deepEqual(sch.list(NOW), []);
  assert.deepEqual(sch.waiting(NOW).map((b) => b.id), [a.booking.id]);
  assert.equal(sch.waiting(NOW)[0].token, undefined); // never sent out
  assert.equal(sch.approve(a.booking.id, NOW).booking.status, 'approved');
  assert.deepEqual(sch.list(NOW).map((b) => b.dj), ['DJ Funk']);
  assert.deepEqual(sch.waiting(NOW), []);
  const b = sch.book(set({ dj: 'Prank', start: NOW + 5 * H }), NOW);
  assert.equal(sch.reject(b.booking.id), true);
  assert.equal(sch.list(NOW).length, 1);
  assert.deepEqual(sch.mine({ [b.booking.id]: b.token }, NOW).map((x) => x.status), ['rejected']);
  assert.deepEqual(sch.mine({ [b.booking.id]: 'wrong' }, NOW), []);
});

await test('pending requests do not hold the room; approval re-checks clashes', () => {
  const sch = new Schedule(null);
  const a = sch.book(set(), NOW);
  const b = sch.book(set({ dj: 'dj funk', start: NOW + 2.5 * H }), NOW); // overlaps a, a still pending
  assert.ok(b.booking);
  assert.ok(sch.approve(a.booking.id, NOW).booking);
  assert.match(sch.approve(b.booking.id, NOW).error, /already has/);
  assert.match(sch.book(set({ start: NOW + 2.5 * H }), NOW).error, /already has/); // a now holds it
  assert.ok(sch.book(set({ start: NOW + 3 * H }), NOW).booking); // right after is fine
  assert.ok(sch.book(set({ dj: 'Other DJ' }), NOW).booking); // other rooms can overlap
});

await test('only the token cancels; ended sets are dropped; bookings persist', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'dance-sched-')), 'data', 'schedule.json');
  const sch = new Schedule(file);
  const a = sch.book(set(), NOW);
  const b = sch.book(set({ dj: 'Late', start: NOW + 10 * H }), NOW);
  sch.approve(a.booking.id, NOW);
  assert.equal(sch.cancel(a.booking.id, 'wrong'), false);
  assert.equal(existsSync(file), true);
  const again = new Schedule(file);
  again.prune(NOW);
  assert.equal(again.list(NOW).length, 1);
  assert.equal(again.waiting(NOW).length, 1);
  assert.equal(again.cancel(a.booking.id, a.token), true);
  assert.equal(again.prune(NOW + 11 * H + 1), true);
  assert.deepEqual(new Schedule(file).list(NOW), []);
  assert.ok(b.token);
});

await test('over the socket: request → admin approves → everyone sees it', async () => {
  const server = startServer({ port: 0, library: false, recordDir: null, scheduleFile: null, statsFile: null, adminKey: 'sesame', log: () => {} });
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
  const boss = await connect();
  await next(fan, (m) => m.type === 'schedule');
  boss.ws.send(JSON.stringify({ type: 'admin', key: 'wrong' }));
  assert.match((await next(boss, (m) => m.type === 'error')).error, /admin key/);
  boss.ws.send(JSON.stringify({ type: 'approve', id: 'x' })); // ignored: not signed in
  boss.ws.send(JSON.stringify({ type: 'admin', key: 'sesame' }));
  await next(boss, (m) => m.type === 'waiting' && m.bookings.length === 0);

  dj.ws.send(JSON.stringify({ type: 'book', ...set({ start: Date.now() + H }) }));
  const ok = await next(dj, (m) => m.type === 'booked');
  assert.equal(ok.booking.status, 'pending');
  await next(dj, (m) => m.type === 'mine' && m.bookings[0]?.status === 'pending');
  const queue = await next(boss, (m) => m.type === 'waiting' && m.bookings.length === 1);
  assert.equal(queue.bookings[0].bio, 'hi');
  assert.equal(fan.inbox.some((m) => m.type === 'schedule' && m.bookings.length), false); // not public yet

  boss.ws.send(JSON.stringify({ type: 'approve', id: ok.booking.id }));
  const seen = await next(fan, (m) => m.type === 'schedule' && m.bookings.length === 1);
  assert.equal(seen.bookings[0].dj, 'DJ Funk');
  await next(dj, (m) => m.type === 'mine' && m.bookings[0]?.status === 'approved');
  await next(boss, (m) => m.type === 'waiting' && m.bookings.length === 0);

  // A fresh page load finds its booking again by token.
  const later = await connect();
  later.ws.send(JSON.stringify({ type: 'mine', tokens: { [ok.booking.id]: ok.token } }));
  assert.equal((await next(later, (m) => m.type === 'mine')).bookings[0].id, ok.booking.id);

  dj.ws.send(JSON.stringify({ type: 'cancel', id: ok.booking.id, token: ok.token }));
  await next(dj, (m) => m.type === 'cancelled');
  await next(fan, (m) => m.type === 'schedule' && m.bookings.length === 0);
  for (const c of [dj, fan, boss, later]) c.ws.close();
  server.close();
});

process.exit(failed ? 1 : 0);
