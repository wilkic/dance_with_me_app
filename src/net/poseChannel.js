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
