import { serializePoseFrame, deserializePoseFrame } from '../pose/poseFormat.js';

/**
 * PoseChannel: the networking seam for future multiplayer.
 *
 * The dance loop publishes every local PoseFrame here. Subscribers receive
 * frames tagged with a dancer id. In the MVP the only transport is
 * LoopbackTransport (frames go nowhere), but a WebRTC/WebSocket transport
 * can be dropped in without touching the render loop: remote frames arrive
 * through the same subscribe() path and get rendered as additional avatars.
 */
export class PoseChannel {
  constructor(transport = new LoopbackTransport()) {
    this.transport = transport;
    this.subscribers = new Set();
    this.localId = crypto.randomUUID();
    this.transport.onReceive = (dancerId, buf) => {
      const frame = deserializePoseFrame(buf);
      for (const cb of this.subscribers) cb(dancerId, frame);
    };
  }

  /** Publish the local dancer's frame (serialized, network-ready). */
  publish(frame) {
    this.transport.send(this.localId, serializePoseFrame(frame));
  }

  /** cb(dancerId, poseFrame) — called for every remote frame. */
  subscribe(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }
}

/** No-op transport for single-player. Verifies the serialization path. */
export class LoopbackTransport {
  constructor() {
    this.onReceive = null;
  }

  send(_dancerId, _buf) {
    // Single-player: frames are dropped. A real transport would push them
    // to peers; remote peers' frames come back via this.onReceive.
  }
}

/**
 * DelayedLoopbackTransport: re-emits every published frame after a fixed
 * delay under a different dancer id — a stand-in for a network peer that
 * happens to be dancing your moves from a minute ago. Powers the "guest
 * dancer" feature, and exercises the full serialize → transmit →
 * deserialize path a real transport will use.
 *
 * Call tick() regularly (once per render frame) to flush due frames.
 */
export class DelayedLoopbackTransport {
  constructor(delayMs = 60000) {
    this.delayMs = delayMs;
    this.queue = [];
    this.onReceive = null;
  }

  send(dancerId, buf) {
    this.queue.push({
      due: performance.now() + this.delayMs,
      id: `guest-of-${dancerId}`,
      buf,
    });
  }

  tick(now = performance.now()) {
    while (this.queue.length && this.queue[0].due <= now) {
      const { id, buf } = this.queue.shift();
      this.onReceive?.(id, buf);
    }
  }

  clear() {
    this.queue.length = 0;
  }
}
