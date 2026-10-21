/**
 * Room music: the room's host plays music to everyone else in the room.
 *
 * Only the host can play (the one who shared the room, or the booked DJ —
 * the server decides, see server/index.js). The host picks a source:
 *   file    one or more audio files on the device, played in a loop
 *           (the host hears them too)
 *   mic     the microphone — or any sound input the computer has, picked
 *           by deviceId: a DJ's virtual cable (VB-Cable, BlackHole) carries
 *           the mix from their DJ software; voice processing is off
 *   screen  a browser tab's or the computer's sound (getDisplayMedia —
 *           desktop Chrome/Edge; phone browsers can't capture other apps)
 *
 * The sound goes straight from the host to each member over WebRTC; the
 * dance server only relays the signalling ('rtc' messages, host ↔ member).
 * The host offers, members answer. Opus is set up for music: stereo, 128 kb/s.
 *
 * So the server can tell the music's tempo, every phone playing it (the
 * host, and each member hearing it — also when the server itself streams
 * a DJ's OBS mix) sends its beat as numbers: 'music' messages with
 * from: 'room' (see audio/onsetEnvelope.js). Never the sound.
 */
import { OnsetEnvelope } from '../audio/onsetEnvelope.js';

const ICE = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_TRIES = 3; // per member: fresh connections after a failure

/** Opus for music, not voice: stereo, high bitrate, no silence suppression. */
function tuneOpus(sdp) {
  const pt = sdp.match(/a=rtpmap:(\d+) opus\/48000/i)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params) => {
    const kept = params.split(';').filter((p) => !/^(stereo|sprop-stereo|maxaveragebitrate|usedtx)=/.test(p.trim()));
    return `a=fmtp:${pt} ${[...kept, 'stereo=1', 'sprop-stereo=1', 'maxaveragebitrate=128000', 'usedtx=0'].join(';')}`;
  });
}

/** Can this browser share a tab's or the system's sound? */
export const canShareScreenAudio = () => !!navigator.mediaDevices?.getDisplayMedia && !/Android|iPhone|iPad/i.test(navigator.userAgent);

/**
 * The computer's sound inputs → [{ id, label }]. Asks for the microphone
 * once first (browsers hide device names until then). Call from a tap.
 */
export async function listSoundInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  let probe = null;
  try { probe = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return []; }
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications')
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1}` }));
  } finally {
    probe.getTracks().forEach((t) => t.stop());
  }
}

export class RoomMusic {
  /**
   * send(msg)       → dance server (JSON control message)
   * onState(state)  ← { hosting, label, hearing, needsTap, error }
   */
  constructor({ send, onState = () => {} }) {
    this.send = send;
    this.onState = onState;
    this.host = null;     // hosting: { kind, label, stream, stop(), peers: Map<id, { pc, queue }>, tries: Map<id, n> }
    this.listen = null;   // listening: { from, pc, queue, audio }
    this.hostId = null;   // who hosts my room (null: nobody / me)
    this.beat = null;     // OnsetEnvelope on whatever this phone plays to or hears from the room
  }

  /** Measure the beat of the room's music as this phone plays it (null: stop). */
  #measure(stream) {
    this.beat?.stop();
    this.beat = stream ? new OnsetEnvelope(stream, (batch) => this.send({ type: 'music', from: 'room', ...batch })) : null;
  }

  get state() {
    return {
      hosting: !!this.host,
      label: this.host?.label ?? null,
      hearing: !!this.listen?.audio?.srcObject,
      needsTap: !!this.listen?.needsTap,
    };
  }
  #emit(extra = {}) { this.onState({ ...this.state, ...extra }); }

  // ---------------------------------------------------------------- host --

  /**
   * Start playing to the room. kind: 'file' (files: FileList/array), 'mic'
   * (deviceId: a specific input, see listSoundInputs) or 'screen'. Call
   * from a tap (browsers want a gesture for audio and screen capture).
   * Throws with a readable message when the source fails.
   */
  async start(kind, files = [], { deviceId = null } = {}) {
    this.stop();
    let src;
    if (kind === 'file') src = await this.#fromFiles([...files]);
    else if (kind === 'mic') src = await this.#fromMic(deviceId);
    else if (kind === 'screen') src = await this.#fromScreen();
    else throw new Error(`unknown source ${kind}`);
    this.host = { kind, ...src, peers: new Map(), tries: new Map() };
    // The source ending by itself (screen share stopped from the browser bar,
    // mic unplugged) stops the music.
    for (const t of src.stream.getAudioTracks()) t.addEventListener('ended', () => { if (this.host?.stream === src.stream) this.stop(); });
    this.send({ type: 'room-music', on: true, label: this.host.label });
    this.#measure(src.stream);
    this.#emit();
  }

  /**
   * Stop playing (host): close every connection, release the source.
   * tell=false keeps quiet to the server (while OBS streams, 'off' would
   * end that stream instead).
   */
  stop(tell = true) {
    const h = this.host;
    if (!h) return;
    this.host = null;
    this.#measure(null);
    for (const [id, p] of h.peers) {
      p.pc.close();
      this.send({ type: 'rtc', to: id, data: { bye: true } });
    }
    h.stop();
    if (tell) this.send({ type: 'room-music', on: false });
    this.#emit();
  }

  /**
   * Back in the room after a reconnect: the server forgot the music and the
   * members dropped their connections, so announce it again and start over.
   */
  rejoined() {
    const h = this.host;
    if (!h) return;
    for (const p of h.peers.values()) p.pc.close();
    h.peers.clear();
    h.tries.clear();
    this.send({ type: 'room-music', on: true, label: h.label });
  }

  /** Host: keep one connection per other member of the room (ids of everyone but me). */
  syncMembers(ids) {
    const h = this.host;
    if (!h) return;
    const want = new Set(ids);
    for (const [id, p] of h.peers) {
      if (!want.has(id)) { p.pc.close(); h.peers.delete(id); h.tries.delete(id); }
    }
    for (const id of want) {
      if (h.peers.has(id) || (h.tries.get(id) ?? 0) >= MAX_TRIES) continue;
      h.tries.set(id, (h.tries.get(id) ?? 0) + 1);
      this.#offer(id);
    }
  }

  async #offer(id) {
    const h = this.host;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const peer = { pc, queue: [] };
    h.peers.set(id, peer);
    for (const track of h.stream.getAudioTracks()) {
      const sender = pc.addTrack(track, h.stream);
      try {
        const params = sender.getParameters();
        params.encodings = [{ ...(params.encodings?.[0] ?? {}), maxBitrate: 128_000 }];
        sender.setParameters(params).catch(() => {});
      } catch { /* not supported: SDP tuning still applies */ }
    }
    pc.onicecandidate = (e) => { if (e.candidate) this.send({ type: 'rtc', to: id, data: { candidate: e.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => {
      // A failed connection is dropped; the next syncMembers tries again.
      if (pc.connectionState === 'failed' && h.peers.get(id) === peer) { pc.close(); h.peers.delete(id); }
    };
    const offer = await pc.createOffer();
    offer.sdp = tuneOpus(offer.sdp);
    await pc.setLocalDescription(offer);
    this.send({ type: 'rtc', to: id, data: { sdp: pc.localDescription.toJSON() } });
  }

  async #fromFiles(files) {
    if (!files.length) throw new Error('No file picked.');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    await ctx.resume?.();
    const audio = new Audio();
    audio.playsInline = true;
    const urls = files.map((f) => URL.createObjectURL(f));
    let i = 0;
    const play = () => { audio.src = urls[i]; return audio.play(); };
    audio.addEventListener('ended', () => { i = (i + 1) % urls.length; play().catch(() => {}); });
    const node = ctx.createMediaElementSource(audio);
    const dest = ctx.createMediaStreamDestination();
    node.connect(dest);
    node.connect(ctx.destination); // the host hears it too
    try { await play(); } catch (err) {
      ctx.close();
      urls.forEach((u) => URL.revokeObjectURL(u));
      throw new Error(`Can't play that file (${err.message}).`);
    }
    const label = files.length > 1 ? `${files[0].name} +${files.length - 1}` : files[0].name;
    return {
      label,
      stream: dest.stream,
      stop: () => { audio.pause(); ctx.close(); urls.forEach((u) => URL.revokeObjectURL(u)); },
    };
  }

  async #fromMic(deviceId) {
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
    } catch (err) {
      throw new Error(`${deviceId ? 'That input' : 'The microphone'} isn't available (${err.message}).`);
    }
    const label = deviceId ? (stream.getAudioTracks()[0]?.label || 'Sound input').slice(0, 60) : 'Microphone';
    return { label, stream, stop: () => stream.getTracks().forEach((t) => t.stop()) };
  }

  async #fromScreen() {
    if (!canShareScreenAudio()) throw new Error('This browser can’t share tab or computer sound — use Chrome on a laptop.');
    let shared;
    try {
      shared = await navigator.mediaDevices.getDisplayMedia({
        video: true, // required by every browser, dropped right away
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch (err) {
      throw new Error(err.name === 'NotAllowedError' ? 'Sharing was cancelled.' : `Sharing failed (${err.message}).`);
    }
    const audio = shared.getAudioTracks();
    shared.getVideoTracks().forEach((t) => t.stop());
    if (!audio.length) {
      throw new Error('No sound came with that share. Pick a tab and switch on “Also share tab audio” (or “Share system audio” for the whole screen).');
    }
    const stream = new MediaStream(audio);
    return { label: `Sound from ${audio[0].label || 'the computer'}`.slice(0, 80), stream, stop: () => audio.forEach((t) => t.stop()) };
  }

  // ----------------------------------------------------------- listener --

  /** The room's host changed (or left): drop a connection from anyone else. */
  setHost(id) {
    this.hostId = id;
    if (this.listen && this.listen.from !== id) this.#hangUp();
  }

  /** The 'rtc' messages relayed by the server. */
  async onSignal(from, data) {
    if (!data) return;
    if (this.host) {
      // Host side: answers and ICE from members.
      const peer = this.host.peers.get(from);
      if (!peer) return;
      if (data.sdp?.type === 'answer') {
        await peer.pc.setRemoteDescription(data.sdp);
        for (const c of peer.queue.splice(0)) peer.pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (peer.pc.remoteDescription) peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.queue.push(data.candidate);
      }
      return;
    }
    // Listener side: the host's offer, ICE, or goodbye.
    if (data.bye) return this.#hangUp(from);
    if (data.sdp?.type === 'offer') {
      this.#hangUp();
      const pc = new RTCPeerConnection({ iceServers: ICE });
      const audio = new Audio();
      audio.playsInline = true;
      audio.autoplay = true;
      const l = (this.listen = { from, pc, queue: [], audio, needsTap: false });
      pc.onicecandidate = (e) => { if (e.candidate) this.send({ type: 'rtc', to: from, data: { candidate: e.candidate.toJSON() } }); };
      pc.ontrack = (e) => {
        audio.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        this.#measure(audio.srcObject);
        audio.play().then(() => { l.needsTap = false; this.#emit(); }).catch(() => { l.needsTap = true; this.#emit(); });
        this.#emit();
      };
      pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && this.listen === l) this.#hangUp(); };
      await pc.setRemoteDescription(data.sdp);
      for (const c of l.queue.splice(0)) pc.addIceCandidate(c).catch(() => {});
      const answer = await pc.createAnswer();
      answer.sdp = tuneOpus(answer.sdp);
      await pc.setLocalDescription(answer);
      this.send({ type: 'rtc', to: from, data: { sdp: pc.localDescription.toJSON() } });
    } else if (data.candidate && this.listen?.from === from) {
      if (this.listen.pc.remoteDescription) this.listen.pc.addIceCandidate(data.candidate).catch(() => {});
      else this.listen.queue.push(data.candidate);
    }
  }

  /** Autoplay was blocked: call from a tap to start hearing. */
  tapToHear() {
    const l = this.listen;
    if (!l) return;
    this.beat?.resume();
    l.audio.play().then(() => { l.needsTap = false; this.#emit(); }).catch(() => {});
  }

  #hangUp(from = null) {
    const l = this.listen;
    if (!l || (from && l.from !== from)) return;
    this.listen = null;
    this.#measure(null);
    l.pc.close();
    l.audio.pause();
    l.audio.srcObject = null;
    this.#emit();
  }

  /** Leaving the room: stop hosting and listening. */
  reset() {
    this.stop();
    this.#hangUp();
    this.hostId = null;
  }
}
