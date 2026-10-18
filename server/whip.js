/**
 * WHIP ingest: a DJ streams their mix from OBS straight to the dance
 * server, which plays it to the room (issue #14).
 *
 *   OBS  ── WebRTC (WHIP) ──►  this server  ── WebRTC ──►  each dancer's phone
 *
 * OBS: Settings → Stream → Service "WHIP", Server https://<host>/whip,
 * Bearer Token = the DJ's stream key (a booking token from /schedule, or
 * the host key of a room shared from a computer). The server answers the
 * offer right away (ICE-lite, no trickle), takes the Opus audio, rejects
 * the video (OBS must send some; it isn't used), and forwards the audio
 * packets untouched to one connection per listener — the phones keep the
 * same listener code as for host-played music, they just get the offer
 * from 'live:<room>' instead of from a phone.
 *
 * HTTP:  POST /whip (Authorization: Bearer KEY, body SDP) → 201, Location
 *        DELETE /whip/<id> → 200          anything else → 405
 * Network: UDP ports WHIP_PORTS (default 50000-50999) must be open; behind
 * 1:1 NAT (Oracle) set WHIP_PUBLIC_IP so the answer names the public address.
 */
import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift';

const MAX_STREAMS = 20;
const MAX_SDP = 100_000;
const SILENT_MS = 20_000; // no audio for this long: the stream is over

const opus = new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 });
const h264 = new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96 });

/** The machine's first non-loopback IPv4 (what the UDP sockets bind to). */
function localIpv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

export class WhipIngest {
  /**
   * resolveKey(key) → room name or null     who may stream to which room
   * send(sessionId, msg)                      JSON to a dancer's socket
   * onStart(room) / onStop(room)              the room's music changed
   */
  constructor({ resolveKey, send, onStart = () => {}, onStop = () => {}, log = () => {},
    publicIp = null,
    ports = '50000-50999' } = {}) {
    this.resolveKey = resolveKey;
    this.send = send;
    this.onStart = onStart;
    this.onStop = onStop;
    this.log = log;
    const [lo, hi] = ports.split('-').map(Number);
    const local = localIpv4();
    this.pcConfig = {
      codecs: { audio: [opus], video: [h264] },
      iceServers: [],
      iceLite: true,
      iceUseIpv6: false,
      icePortRange: [lo, hi],
      ...(local ? { iceInterfaceAddresses: { udp4: local } } : {}),
      ...(publicIp ? { iceAdditionalHostAddresses: [publicIp] } : {}),
    };
    this.streams = new Map(); // room -> { id, room, pc, track, listeners: Map<sessionId, { pc }>, lastRtp, watchdog }
    this.byId = new Map();    // stream id -> stream
  }

  /** Is a stream playing to this room? → { label } or null. */
  liveIn(room) {
    const s = this.streams.get(room);
    return s?.track ? { label: 'Live from OBS', live: true } : null;
  }

  /** Mount on an http server: returns true if the request was ours. */
  handle(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/whip')) return false;
    const done = (status, body = '', headers = {}) => { res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers }); res.end(body); };
    if (req.method === 'OPTIONS') return done(204, '', { Allow: 'POST, DELETE, OPTIONS' }), true;
    if (req.method === 'POST' && url.pathname === '/whip') {
      const key = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim().slice(0, 100);
      const room = key ? this.resolveKey(key) : null;
      if (!room) return done(401, 'That stream key isn’t valid right now.'), true;
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > MAX_SDP) req.destroy(); });
      req.on('end', () => {
        this.#start(room, body).then(
          ({ id, sdp }) => done(201, sdp, { 'Content-Type': 'application/sdp', Location: `/whip/${id}` }),
          (err) => { this.log(`whip: ${room}: ${err.message}`); done(400, `Could not start the stream (${err.message}).`); },
        );
      });
      return true;
    }
    const m = url.pathname.match(/^\/whip\/([\w-]+)$/);
    if (m && req.method === 'DELETE') {
      const s = this.byId.get(m[1]);
      if (!s) return done(404), true;
      this.end(s.room, 'OBS stopped');
      return done(200), true;
    }
    if (m && req.method === 'PATCH') return done(405, '', { Allow: 'DELETE' }), true; // no trickle: the answer is complete
    return done(m || url.pathname === '/whip' ? 405 : 404), true;
  }

  async #start(room, offerSdp) {
    if (!offerSdp.includes('m=audio')) throw new Error('no audio in the offer');
    if (this.streams.size >= MAX_STREAMS && !this.streams.has(room)) throw new Error('too many streams');
    this.end(room, 'replaced'); // OBS reconnecting after a drop: the new stream wins
    const id = randomUUID().slice(0, 12);
    const pc = new RTCPeerConnection(this.pcConfig);
    const s = { id, room, pc, track: null, listeners: new Map(), lastRtp: Date.now(), watchdog: null };
    this.streams.set(room, s);
    this.byId.set(id, s);
    pc.onTrack.subscribe((track) => {
      if (track.kind !== 'audio' || s.track) return;
      s.track = track;
      track.onReceiveRtp.subscribe(() => { s.lastRtp = Date.now(); });
      s.watchdog = setInterval(() => { if (Date.now() - s.lastRtp > SILENT_MS) this.end(room, 'no audio for 20 s'); }, 5000);
      this.log(`♫ OBS stream live in room ${room}`);
      this.onStart(room);
    });
    pc.connectionStateChange.subscribe((state) => {
      if (['failed', 'closed', 'disconnected'].includes(state) && this.streams.get(room) === s) this.end(room, state);
    });
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    for (const t of pc.getTransceivers()) if (t.kind === 'video') t.direction = 'inactive';
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { id, sdp: pc.localDescription.sdp };
  }

  /** The stream to `room` is over (OBS stopped, dropped, or an admin/host said so). */
  end(room, why = '') {
    const s = this.streams.get(room);
    if (!s) return false;
    this.streams.delete(room);
    this.byId.delete(s.id);
    clearInterval(s.watchdog);
    for (const [sid, l] of s.listeners) { l.pc.close(); this.send(sid, { type: 'rtc', from: `live:${room}`, data: { bye: true } }); }
    s.listeners.clear();
    s.pc.close();
    this.log(`♫ OBS stream in room ${room} ended${why ? ` (${why})` : ''}`);
    if (s.track) this.onStop(room);
    return true;
  }

  /** Keep one connection per listener (session ids) of the room; call whenever membership changes. */
  sync(room, sessionIds) {
    const s = this.streams.get(room);
    if (!s?.track) return;
    const want = new Set(sessionIds);
    for (const [sid, l] of s.listeners) if (!want.has(sid)) { l.pc.close(); s.listeners.delete(sid); }
    for (const sid of want) if (!s.listeners.has(sid)) this.#offer(s, sid).catch((err) => this.log(`whip: offer to ${sid}: ${err.message}`));
  }

  async #offer(s, sid) {
    const pc = new RTCPeerConnection({ ...this.pcConfig, codecs: { audio: [opus] } });
    const l = { pc };
    s.listeners.set(sid, l);
    pc.addTrack(s.track);
    pc.connectionStateChange.subscribe((state) => {
      // Dropped: forget it; the next sync (every scan) offers again.
      if (['failed', 'closed'].includes(state) && s.listeners.get(sid) === l) { s.listeners.delete(sid); pc.close(); }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (s.listeners.get(sid) !== l) return;
    this.send(sid, { type: 'rtc', from: `live:${s.room}`, data: { sdp: { type: 'offer', sdp: pc.localDescription.sdp } } });
  }

  /** An 'rtc' message from a listener addressed to live:<room>. */
  async onSignal(room, sid, data) {
    const l = this.streams.get(room)?.listeners.get(sid);
    if (!l || !data) return;
    try {
      if (data.sdp?.type === 'answer') await l.pc.setRemoteDescription(data.sdp);
      else if (data.candidate?.candidate) await l.pc.addIceCandidate(data.candidate);
    } catch (err) {
      this.log(`whip: signal from ${sid}: ${err.message}`);
    }
  }

  /** Streams playing right now (admin view). */
  list() {
    return [...this.streams.values()].filter((s) => s.track).map((s) => ({ room: s.room, listeners: s.listeners.size }));
  }

  close() {
    for (const room of [...this.streams.keys()]) this.end(room, 'server stopping');
  }
}
