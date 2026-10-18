/**
 * Visit stats: daily totals only (see stats.js, /privacy/) — what counts,
 * what doesn't, Brussels days, junk referrers, the admin-only view, and
 * the file round trip.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, scheduleFile: null, adminKey: 'k', statsFile: null, log: () => {} });
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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stats, dayOf, refHost } from '../stats.js';

await test('Stats: counters, devices, referrers, Brussels days, 14-day view', async () => {
  const st = new Stats(null);
  const t = Date.UTC(2026, 9, 18, 22, 30); // 00:30 on the 19th in Brussels (CEST)
  assert.equal(dayOf(t), '2026-10-19');
  st.visit({ page: 'app', ref: 'l.facebook.com', phone: true }, t);
  st.visit({ page: 'app', ref: '', phone: false }, t);
  st.visit({ page: 'schedule', ref: 'www.Instagram.com' }, t);
  st.visit({ page: 'nope' }, t);
  st.count('danced', t);
  st.count('made-up', t);
  st.online(3, t);
  st.online(2, t);
  const [today, yesterday] = st.recent(14, t);
  assert.equal(today.day, '2026-10-19');
  assert.equal(yesterday.day, '2026-10-18');
  assert.deepEqual([today.app, today.schedule, today.phone, today.computer, today.danced, today.peak], [2, 1, 1, 1, 1, 3]);
  assert.deepEqual(today.ref, { 'l.facebook.com': 1, direct: 1, 'instagram.com': 1 });
  assert.equal(yesterday.app, 0);
  assert.equal(st.recent(14, t).length, 14);
  assert.equal(refHost('javascript:alert(1)'), null);
  assert.equal(refHost(''), 'direct');
});

await test('Stats: saved to and read back from the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stats-'));
  const file = join(dir, 'stats.json');
  const a = new Stats(file);
  a.count('shared');
  a.save(Date.now(), true);
  assert.ok(readFileSync(file, 'utf8').includes('"shared":1'));
  assert.equal(new Stats(file).recent(1)[0].shared, 1);
  rmSync(dir, { recursive: true });
});

await test('server: visits count once per connection, rooms/music/dancing count, only admins see stats', async () => {
  const a = await connect();
  const b = await connect();
  await next(a, (m) => m.type === 'welcome');
  sendTo(a, { type: 'visit', page: 'app', ref: 'whatsapp.com', phone: true });
  sendTo(a, { type: 'visit', page: 'app', ref: 'whatsapp.com', phone: true }); // a reconnect-ish repeat: ignored
  sendTo(b, { type: 'visit', page: 'schedule', ref: '' });
  sendTo(a, { type: 'join', room: 'counted', hostKey: 'h' });
  await next(a, (m) => m.type === 'joined');
  sendTo(b, { type: 'join', room: 'counted' });
  await next(b, (m) => m.type === 'joined');
  sendTo(a, { type: 'room-music', on: true, label: 'a' });
  sendTo(a, { type: 'room-music', on: true, label: 'b' }); // a new track, same music session
  await next(b, (m) => m.type === 'room' && m.music?.label === 'b');

  sendTo(b, { type: 'stats' });
  await quiet(b, (m) => m.type === 'stats');
  sendTo(b, { type: 'admin', key: 'k' });
  const { days, online } = await next(b, (m) => m.type === 'stats');
  const t = days[0];
  assert.deepEqual([t.app, t.schedule, t.phone, t.shared, t.joined, t.music], [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(t.ref, { 'whatsapp.com': 1, direct: 1 });
  assert.ok(t.peak >= 2 && online >= 2);
  assert.equal(JSON.stringify(days).includes(a.id), false); // nothing about who
  a.ws.close(); b.ws.close();
});

server.close();
process.exit(failed ? 1 : 0);
