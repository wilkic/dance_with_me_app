/**
 * Dance keys (keys.js): no key, no recording; a key is made on request;
 * clips go under the key and not into the library; the owner can delete
 * everything; keys unused for 30 days are purged.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, readdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../index.js';
import { Keys, normalizeKey } from '../keys.js';
import { serializePoseFrame, emptyPoseFrame } from '../../src/pose/poseFormat.js';

const dir = mkdtempSync(join(tmpdir(), 'dance-keys-'));
const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, keysDir: dir, scheduleFile: null, statsFile: null, adminKey: 'k', log: () => {} });
await new Promise((r) => server.wss.on('listening', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function phone() {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const inbox = [];
  ws.on('message', (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
  await new Promise((r) => ws.on('open', r));
  const next = async (pred) => {
    for (let i = 0; i < 100; i++) { const k = inbox.findIndex(pred); if (k >= 0) return inbox.splice(k, 1)[0]; await sleep(20); }
    throw new Error(`timed out waiting (${pred})`);
  };
  let t = 0;
  const dance = (n) => { for (let i = 0; i < n; i++) { const f = emptyPoseFrame(); f.t = (t += 33); ws.send(serializePoseFrame(f)); } };
  const say = (m) => ws.send(JSON.stringify(m));
  return { ws, inbox, next, dance, say };
}
const clipsIn = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl') && f !== 'sessions.jsonl') : []);
const folders = () => readdirSync(dir);

const a = await phone();
assert.equal((await a.next((m) => m.type === 'welcome')).keys, true, 'the server says keys work here');

// No key: Record does nothing.
a.say({ type: 'rec', on: true });
a.dance(400); await sleep(150);
assert.equal(a.inbox.some((m) => m.type === 'rec'), false);
assert.equal(folders().length, 0, 'nothing on disk without a key');

// A made-up key is not a key.
a.say({ type: 'ai-key', key: 'ABCDE-FGHJK-MNPQR-STVWX' });
assert.equal((await a.next((m) => m.type === 'ai-key')).reason, 'unknown');

// Ask for one.
a.say({ type: 'ai-key', create: true });
const made = await a.next((m) => m.type === 'ai-key');
assert.equal(made.ok && made.created, true);
assert.match(made.key, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
assert.equal(made.days, 30);
assert.equal(folders().length, 1);
assert.equal(folders()[0].includes(normalizeKey(made.key)), false, 'the folder name is not the key');
const keyDir = join(dir, folders()[0]);

// Record a clip with it.
a.say({ type: 'rec', on: true });
await a.next((m) => m.type === 'rec' && m.on);
a.dance(450);
a.say({ type: 'rec', on: false });
const r = await a.next((m) => m.type === 'rec' && !m.on);
assert.deepEqual([r.kept, r.frames], [true, 328]); // the last 4 s are cut, as in the home studio
assert.equal(clipsIn(keyDir).length, 1, 'the clip is under the key');
assert.equal(server.library, null);

// Another phone, the same key, typed sloppily (lower case, spaces, O for 0).
const b = await phone();
await b.next((m) => m.type === 'welcome');
b.say({ type: 'ai-key', key: made.key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o') });
const seen = await b.next((m) => m.type === 'ai-key');
assert.deepEqual([seen.ok, seen.clips, seen.seconds], [true, 1, r.seconds]);
assert.equal(seen.key, undefined, 'the key is only ever sent when it is made');

// The owner deletes it: all gone, and the other phone can no longer record.
b.say({ type: 'ai-key', key: made.key, forget: true });
assert.equal((await b.next((m) => m.type === 'ai-key')).forgotten, true);
assert.equal(folders().length, 0, 'key and clips deleted');
a.say({ type: 'rec', on: true });
a.dance(400); await sleep(150);
assert.equal(a.inbox.some((m) => m.type === 'rec'), false, 'a deleted key records nothing');
a.say({ type: 'ai-key', key: made.key });
assert.equal((await a.next((m) => m.type === 'ai-key')).reason, 'unknown');

// One connection can't mint keys without end.
a.say({ type: 'ai-key', create: true }); await a.next((m) => m.type === 'ai-key' && m.ok);
a.say({ type: 'ai-key', create: true });
assert.equal((await a.next((m) => m.type === 'ai-key')).reason, 'limit');
a.ws.close(); b.ws.close();
server.close();

// 30 days without use: purged. A key used meanwhile, or in use now, stays.
let clock = Date.parse('2026-01-01T00:00:00Z');
const keys = new Keys(dir, { now: () => clock });
for (const f of folders()) rmSync(join(dir, f), { recursive: true });
const old = keys.create(), used = keys.create(), live = keys.create();
clock += 20 * 86400e3;
keys.touch(used.id);
clock += 11 * 86400e3; // old and live: 31 days idle; used: 11
assert.equal(keys.purge(new Set([live.id])), 1);
assert.equal(keys.find(old.key), null);
assert.ok(keys.find(used.key) && keys.find(live.key));
assert.equal(keys.info(used.id).expiresAt, new Date(Date.parse('2026-01-21T00:00:00Z') + 30 * 86400e3).toISOString());
// A full key (the per-key allowance of kept dancing) says so.
writeFileSync(join(keys.clipDir(used.id), 'sessions.jsonl'), JSON.stringify({ seconds: 3601 }) + '\n');
assert.equal(keys.info(used.id).full, true);
assert.ok(readFileSync(join(keys.clipDir(used.id), 'meta.json'), 'utf8').includes('lastUsedAt'));

rmSync(dir, { recursive: true, force: true });
console.log('PASS  dance keys: no key no recording; made on request; clips under the key only; delete on request; purge after 30 idle days');
process.exit(0);
