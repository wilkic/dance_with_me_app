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
 * DelayedLoopbackTransport: re-emits every published frame under different
 * dancer ids, one per guest slot — stand-ins for network peers that happen
 * to be dancing your moves from a while ago. Guest N's frames arrive
 * spacingMs * N after the original. Powers the "guest dancer" feature, and
 * exercises the full serialize → transmit → deserialize path a real
 * transport will use.
 *
 * Entries store their send time rather than a due time, so configure() can
 * change guests/spacing mid-dance and already-queued frames retime too.
 *
 * Call tick() regularly (once per render frame) to flush due frames.
 */
export class DelayedLoopbackTransport {
  constructor({ guests = 1, spacingMs = 60000 } = {}) {
    this.guests = guests;
    this.spacingMs = spacingMs;
    this.queues = []; // per guest slot: [{ sentAt, id, buf }]
    this.onReceive = null;
  }

  configure({ guests, spacingMs } = {}) {
    if (guests !== undefined) this.guests = guests;
    if (spacingMs !== undefined) this.spacingMs = spacingMs;
    if (this.queues.length > this.guests) this.queues.length = this.guests;
  }

  send(dancerId, buf) {
    const sentAt = performance.now();
    for (let g = 0; g < this.guests; g++) {
      (this.queues[g] ??= []).push({ sentAt, id: `guest-${g + 1}-of-${dancerId}`, buf });
    }
  }

  tick(now = performance.now()) {
    for (let g = 0; g < this.queues.length; g++) {
      const q = this.queues[g];
      const delay = this.spacingMs * (g + 1);
      while (q.length && q[0].sentAt + delay <= now) {
        const { id, buf } = q.shift();
        this.onReceive?.(id, buf);
      }
    }
  }

  clear() {
    this.queues.length = 0;
  }
}
