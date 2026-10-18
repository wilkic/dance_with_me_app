import { serializePoseFrame, deserializePoseFrame } from '../pose/poseFormat.js';
import { decodeEnvelope } from './envelope.js';

/**
 * PoseChannel: the networking seam for future multiplayer.
 *
 * The dance loop publishes every local PoseFrame here. Subscribers receive
 * frames tagged with a dancer id. Transports: LoopbackTransport (frames go
 * nowhere), WebSocketTransport (the dance server relays room-mates' frames back).
 * Remote frames all arrive through the same subscribe() path and get
 * rendered as additional avatars.
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
 * WebSocketTransport: streams serialized PoseFrames to the dance server
 * (binary frames) and surfaces its JSON opinions — profile, room, match,
 * unmatch — via onMessage. Binary frames from the server are relay
 * envelopes carrying room-mates' PoseFrames; they arrive through the
 * standard onReceive path and render as guest avatars. Reconnects
 * automatically and re-joins the current room on every (re)connect.
 */
export class WebSocketTransport {
  constructor(url) {
    this.url = url;
    this.onReceive = null;
    this.onMessage = null;
    this.onOpen = null;   // fires on every (re)connect — resend session state here
    this.onStatus = null; // 'connecting' | 'open' | 'closed'
    this.room = null;     // room to (re)join on connect
    this.joinExtra = {};  // sent with every join: { hostKey, bookingToken }
    this.ws = null;
    this.closed = false;
    this.#connect();
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  #connect() {
    this.onStatus?.('connecting');
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      this.onStatus?.('open');
      if (this.room) this.sendJSON({ type: 'join', room: this.room, ...this.joinExtra });
      this.onOpen?.();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try { this.onMessage?.(JSON.parse(ev.data)); } catch { /* ignore bad JSON */ }
      } else {
        const { dancerId, frameBytes } = decodeEnvelope(ev.data);
        this.onReceive?.(dancerId, frameBytes);
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.ws = null;
      this.onStatus?.('closed');
      if (!this.closed) setTimeout(() => this.#connect(), 3000);
    };
    this.ws = ws;
  }

  send(_dancerId, buf) {
    if (this.connected) this.ws.send(buf);
  }

  /** Text-frame control message (labels etc.) — see server/index.js. */
  sendJSON(obj) {
    if (this.connected) this.ws.send(JSON.stringify(obj));
  }

  /**
   * Enter a dance room (created if it doesn't exist). Sticky across
   * reconnects. extra: { hostKey, bookingToken } — who may host it.
   */
  join(room, extra = {}) {
    this.room = room;
    this.joinExtra = extra;
    this.sendJSON({ type: 'join', room, ...extra });
  }

  /** Back to solo dancing. */
  leave() {
    this.room = null;
    this.sendJSON({ type: 'leave' });
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }
}

/** Fans one channel out over several transports (e.g. guests + server). */
export class CompositeTransport {
  constructor(transports) {
    this.transports = transports;
  }

  set onReceive(cb) {
    for (const t of this.transports) t.onReceive = cb;
  }

  send(id, buf) {
    for (const t of this.transports) t.send(id, buf);
  }

  tick(now) {
    for (const t of this.transports) t.tick?.(now);
  }

  clear() {
    for (const t of this.transports) t.clear?.();
  }
}
