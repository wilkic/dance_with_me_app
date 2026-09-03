/**
 * Relay envelope: a PoseFrame tagged with its dancer id, for fan-out from
 * the server to the other members of a room.
 *
 *   [uint8 idLength][idLength bytes: dancer id, ASCII][serialized PoseFrame]
 *
 * Shared by the client (src/net/poseChannel.js) and the server
 * (server/index.js), so both sides stay in lock-step.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Wrap a serialized PoseFrame with its sender's id. Returns a Uint8Array. */
export function encodeEnvelope(dancerId, frameBytes) {
  const id = enc.encode(dancerId);
  if (id.length > 255) throw new Error('dancer id too long');
  const body = frameBytes instanceof Uint8Array ? frameBytes : new Uint8Array(frameBytes);
  const out = new Uint8Array(1 + id.length + body.length);
  out[0] = id.length;
  out.set(id, 1);
  out.set(body, 1 + id.length);
  return out;
}

/** Split an envelope into { dancerId, frameBytes } (frameBytes: ArrayBuffer). */
export function decodeEnvelope(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const n = u8[0];
  const dancerId = dec.decode(u8.subarray(1, 1 + n));
  const frameBytes = u8.slice(1 + n).buffer;
  return { dancerId, frameBytes };
}
