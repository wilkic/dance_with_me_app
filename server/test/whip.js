/**
 * OBS streaming over WHIP (whip.js): a stand-in for OBS offers audio+video
 * to POST /whip with a stream key; the server takes the audio and plays
 * it to the room's listeners itself. Keys: a room's host key, or an
 * approved booking's token. Wrong keys are refused.
 */
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../index.js';

let failed = 0;
const test = async (label, fn) => {
  try { await fn(); console.log(`PASS  ${label}`); } catch (e) { failed++; console.log(`FAIL  ${label}\n      ${e.stack}`); }
};

const server = startServer({ whipPorts: '51000-51050',  port: 0, scanIntervalMs: 60_000, library: false, recordDir: null, scheduleFile: null, adminKey: 'k', statsFile: null, log: () => {} });
await new Promise((r) => server.wss.on('listening', r));

const connect = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
  const c = { ws, id: null, inbox: [], waiters: [] };
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'welcome') c.id = m.id;
    c.inbox.push(m);
    for (const w of c.waiters.splice(0)) w();
  });
  ws.on('open', () => resolve(c));
});
const next = async (c, pred, ms = 2000) => {
  const until = Date.now() + ms;
  for (;;) {
    const i = c.inbox.findIndex(pred);
    if (i >= 0) return c.inbox.splice(i, 1)[0];
    if (Date.now() > until) throw new Error(`timed out waiting (${pred})`);
    await new Promise((r) => { c.waiters.push(r); setTimeout(r, 50); });
  }
};
const quiet = async (c, pred, ms = 300) => {
  await new Promise((r) => setTimeout(r, ms));
  assert.equal(c.inbox.some(pred), false, `unexpected message (${pred})`);
};
const sendTo = (c, msg) => c.ws.send(JSON.stringify(msg));
import { RTCPeerConnection, MediaStreamTrack, RtpPacket, RtpHeader, RTCRtpCodecParameters } from 'werift';

const opus = new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111 });
const h264 = new RTCRtpCodecParameters({ mimeType: 'video/H264', clockRate: 90000, payloadType: 96 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An OBS stand-in: audio + video sendonly, no candidates of its own (it's behind NAT). */
async function obsOffer() {
  const pc = new RTCPeerConnection({ codecs: { audio: [opus], video: [h264] }, iceServers: [] });
  const track = new MediaStreamTrack({ kind: 'audio' });
  pc.addTransceiver(track, { direction: 'sendonly' });
  pc.addTransceiver(new MediaStreamTrack({ kind: 'video' }), { direction: 'sendonly' });
  await pc.setLocalDescription(await pc.createOffer());
  await sleep(200);
  const sdp = pc.localDescription.sdp.split('\r\n').filter((l) => !l.startsWith('a=candidate')).join('\r\n');
  let seq = 0;
  const timer = setInterval(() => track.writeRtp(new RtpPacket(new RtpHeader({ payloadType: 111, sequenceNumber: seq++ & 0xffff, timestamp: (seq * 960) >>> 0, ssrc: 4242 }), Buffer.alloc(40, 7))), 20);
  return { pc, sdp, stop: () => { clearInterval(timer); pc.close(); } };
}
const whipUrl = `http://127.0.0.1:${server.port}/whip`;
const post = (key, sdp) => fetch(whipUrl, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/sdp' }, body: sdp });

/** A phone's listener side, in Node: answers the 'live:' offer, counts packets. */
async function listen(c, room) {
  const offer = await next(c, (m) => m.type === 'rtc' && m.from === `live:${room}` && m.data?.sdp?.type === 'offer', 5000);
  const pc = new RTCPeerConnection({ codecs: { audio: [opus] }, iceServers: [] });
  const got = { rtp: 0 };
  pc.onTrack.subscribe((t) => t.onReceiveRtp.subscribe(() => got.rtp++));
  pc.onIceCandidate.subscribe((cand) => { if (cand) sendTo(c, { type: 'rtc', to: `live:${room}`, data: { candidate: cand.toJSON() } }); });
  await pc.setRemoteDescription(offer.data.sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  sendTo(c, { type: 'rtc', to: `live:${room}`, data: { sdp: { type: 'answer', sdp: pc.localDescription.sdp } } });
  return { pc, got };
}

await test('wrong key → 401; nothing else answers on /whip', async () => {
  const obs = await obsOffer();
  assert.equal((await post('nope', obs.sdp)).status, 401);
  assert.equal((await fetch(whipUrl, { method: 'GET' })).status, 405);
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/elsewhere`)).status, 404);
  obs.stop();
});

await test('host key: OBS streams to a shared room; two listeners hear it; the host can stop it', async () => {
  const host = await connect();
  const a = await connect();
  const b = await connect();
  sendTo(host, { type: 'join', room: 'obs-room', hostKey: 'stream-key-1' });
  await next(host, (m) => m.type === 'joined' && m.host);
  for (const c of [a, b]) { sendTo(c, { type: 'join', room: 'obs-room' }); await next(c, (m) => m.type === 'joined'); }

  const obs = await obsOffer();
  const res = await post('stream-key-1', obs.sdp);
  assert.equal(res.status, 201);
  assert.match(res.headers.get('location'), /^\/whip\/[\w-]+$/);
  const answer = await res.text();
  assert.match(answer, /a=ice-lite/);
  assert.match(answer.slice(answer.indexOf('m=video')), /a=inactive/); // video not taken
  await obs.pc.setRemoteDescription({ type: 'answer', sdp: answer });

  const room = await next(a, (m) => m.type === 'room' && m.music?.live, 5000);
  assert.equal(room.music.label, 'Live from OBS');
  const [la, lb] = await Promise.all([listen(a, 'obs-room'), listen(b, 'obs-room')]);
  await quiet(host, (m) => m.type === 'rtc'); // the host doesn't listen to their own stream
  await sleep(2500);
  assert.ok(la.got.rtp > 50 && lb.got.rtp > 50, `rtp ${la.got.rtp} / ${lb.got.rtp}`);

  // The host's phone can't play over it, but can stop it.
  sendTo(host, { type: 'room-music', on: true, label: 'mine.mp3' });
  await quiet(a, (m) => m.type === 'room' && m.music?.label === 'mine.mp3');
  sendTo(host, { type: 'room-music', on: false });
  await next(a, (m) => m.type === 'rtc' && m.data?.bye, 3000);
  await next(a, (m) => m.type === 'room' && !m.music, 3000);
  assert.equal(obs.pc.connectionState === 'connected', true); // OBS doesn't know yet; it finds out when it reconnects
  assert.equal((await post('stream-key-1', obs.sdp)).status, 201); // …and may start again
  obs.stop(); la.pc.close(); lb.pc.close();
  host.ws.close(); a.ws.close(); b.ws.close();
});

await test('booking token: the booked DJ streams without a phone; a late joiner gets the stream; DELETE ends it', async () => {
  const admin = await connect();
  const dj = await connect();
  sendTo(admin, { type: 'admin', key: 'k' });
  await next(admin, (m) => m.type === 'waiting');
  const start = Math.ceil(Date.now() / 60_000) * 60_000 + 30 * 60_000; // in half an hour: setup time
  sendTo(dj, { type: 'book', dj: 'DJ Whip', start, minutes: 60 });
  const booked = await next(dj, (m) => m.type === 'booked');
  sendTo(admin, { type: 'approve', id: booked.booking.id });
  await next(dj, (m) => m.type === 'mine' && m.bookings[0]?.status === 'approved');

  const obs = await obsOffer();
  const res = await post(booked.token, obs.sdp);
  assert.equal(res.status, 201);
  await obs.pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
  await sleep(500);
  const dancer = await connect();
  sendTo(dancer, { type: 'join', room: 'dj-whip' });
  await next(dancer, (m) => m.type === 'joined');
  await next(dancer, (m) => m.type === 'room' && m.music?.live, 5000);
  const l = await listen(dancer, 'dj-whip');
  await sleep(2000);
  assert.ok(l.got.rtp > 40, `rtp ${l.got.rtp}`);

  assert.equal((await fetch(`http://127.0.0.1:${server.port}${res.headers.get('location')}`, { method: 'DELETE' })).status, 200);
  await next(dancer, (m) => m.type === 'rtc' && m.data?.bye, 3000);
  await next(dancer, (m) => m.type === 'room' && !m.music, 3000);
  obs.stop(); l.pc.close();
  admin.ws.close(); dj.ws.close(); dancer.ws.close();
});

server.close();
process.exit(failed ? 1 : 0);
