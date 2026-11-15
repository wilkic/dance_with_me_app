/**
 * The Record button (recordButton: dance-home.sh): nothing is recorded until
 * a dancer presses Record; each Record → Stop is one clip; short ones are
 * dropped.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../index.js';
import { serializePoseFrame, emptyPoseFrame } from '../../src/pose/poseFormat.js';

const dir = mkdtempSync(join(tmpdir(), 'rec-button-'));
const server = startServer({ port: 0, scanIntervalMs: 60_000, library: false, recordDir: dir, recordButton: true, scheduleFile: null, statsFile: null, adminKey: 'k', log: () => {} });
await new Promise((r) => server.wss.on('listening', r));

const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
const inbox = [];
ws.on('message', (d, bin) => { if (!bin) inbox.push(JSON.parse(d.toString())); });
await new Promise((r) => ws.on('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const next = async (pred) => {
  for (let i = 0; i < 100; i++) { const k = inbox.findIndex(pred); if (k >= 0) return inbox.splice(k, 1)[0]; await sleep(20); }
  throw new Error(`timed out waiting (${pred})`);
};
let t = 0;
const dance = (n) => { for (let i = 0; i < n; i++) { const f = emptyPoseFrame(); f.t = (t += 33); ws.send(serializePoseFrame(f)); } };
const clips = () => readdirSync(dir).filter((f) => f.endsWith('.jsonl') && f !== 'sessions.jsonl');

assert.equal((await next((m) => m.type === 'welcome')).recording, 'button');
ws.send(JSON.stringify({ type: 'join', room: 'home' }));
await next((m) => m.type === 'joined');

dance(400); await sleep(100);
assert.equal(clips().length, 0, 'nothing is recorded before Record');

ws.send(JSON.stringify({ type: 'rec', on: true }));
await next((m) => m.type === 'rec' && m.on);
dance(450);
ws.send(JSON.stringify({ type: 'rec', on: false }));
let r = await next((m) => m.type === 'rec' && !m.on);
// 450 frames, 33 ms apart; the last 4 s (122 frames) are cut off: the walk to the Stop button.
assert.deepEqual([r.kept, r.frames, r.seconds], [true, 328, 11]);
assert.equal(clips().length, 1, 'one clip');

await sleep(1100); // clip names carry the second they started in
ws.send(JSON.stringify({ type: 'rec', on: true }));
await next((m) => m.type === 'rec' && m.on);
dance(20);
ws.send(JSON.stringify({ type: 'rec', on: false }));
r = await next((m) => m.type === 'rec' && !m.on);
assert.deepEqual([r.kept, r.frames], [false, 0]);
assert.equal(clips().length, 1, 'a short clip is dropped');

ws.send(JSON.stringify({ type: 'rec', on: true }));
await next((m) => m.type === 'rec' && m.on);
dance(450); await sleep(100);
ws.close(); await sleep(200);
assert.equal(clips().length, 2, 'leaving while recording keeps the clip');

server.close();
rmSync(dir, { recursive: true, force: true });
console.log('PASS  record button: nothing before Record; Record → Stop is one clip; short clips dropped; leaving ends the clip');
process.exit(0);
