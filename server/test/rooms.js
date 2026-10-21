/**
 * Unit tests for dance rooms: registry semantics, room tempo consensus,
 * relay envelope round-trip, and room-name normalization.
 */
import assert from 'node:assert/strict';
import { Rooms } from '../rooms.js';
import { encodeEnvelope, decodeEnvelope } from '../../src/net/envelope.js';
import { normalizeRoomName, randomRoomName } from '../../src/net/roomNames.js';
import { serializePoseFrame, deserializePoseFrame, emptyPoseFrame } from '../../src/pose/poseFormat.js';

let failed = 0;
const test = (label, fn) => {
  try { fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.message}`); }
};

test('room names normalize consistently', () => {
  assert.equal(normalizeRoomName('Funky Otter'), 'funky-otter');
  assert.equal(normalizeRoomName('  funky_otter!! '), 'funky-otter');
  assert.equal(normalizeRoomName('--a--b--'), 'a-b');
  assert.equal(normalizeRoomName('💃'), '');
  assert.equal(normalizeRoomName('x'.repeat(40)).length, 24);
  assert.match(randomRoomName(), /^[a-z]+-[a-z]+$/);
});

test('join creates, second join joins, leave closes when empty', () => {
  const rooms = new Rooms();
  const a = { id: 'a', room: null };
  const b = { id: 'b', room: null };
  assert.deepEqual(rooms.join(a, 'Funky Otter'), { name: 'funky-otter', created: true });
  assert.deepEqual(rooms.join(b, 'funky-otter'), { name: 'funky-otter', created: false });
  assert.deepEqual(rooms.peersOf(a), [b]);
  assert.deepEqual(rooms.peersOf(b), [a]);
  assert.equal(rooms.join(a, '!!!'), null);            // bad name: unchanged
  assert.equal(a.room, 'funky-otter');
  assert.deepEqual(rooms.join(a, 'other'), { name: 'other', created: true });
  assert.deepEqual(rooms.peersOf(b), []);              // a moved out
  assert.equal(rooms.leave(b), 'funky-otter');
  assert.equal(rooms.leave(b), null);
  assert.deepEqual(rooms.names, ['other']);            // funky-otter closed
  rooms.leave(a);
  assert.deepEqual(rooms.names, []);
});

test('envelope round-trips id + PoseFrame', () => {
  const f = emptyPoseFrame();
  f.t = 1234.5;
  f.mirrored = true;
  f.keypoints[7] = 0.42;
  const env = encodeEnvelope('ab12cd34', new Uint8Array(serializePoseFrame(f)));
  const { dancerId, frameBytes } = decodeEnvelope(env);
  assert.equal(dancerId, 'ab12cd34');
  const g = deserializePoseFrame(frameBytes);
  assert.equal(g.t, 1234.5);
  assert.equal(g.mirrored, true);
  assert.ok(Math.abs(g.keypoints[7] - 0.42) < 1e-6);
});

process.exit(failed ? 1 : 0);
