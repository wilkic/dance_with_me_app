/**
 * Session recorder: every dance session becomes library material.
 *
 * One JSONL per session in library/sessions/ (the lab format, so
 * lab/run.js analyze and lab/drop.js work on it unchanged):
 *   { type:'label', session:true, id, at, ... }   provenance + sharing levels
 *   { type:'label', clickBpm }                    metronome ground truth (?click=)
 *   { t, k:[132 numbers] }                        PoseFrames — the "points" video level
 *   { type:'tempo', t, bpm, confidence, musicBpm, musicConfidence }  every scan
 *   { type:'music', t0, hz, e:[...], from? }      onset envelope (music level "beat"/"audio"; from 'room': the room's music)
 * Full media, when the dancer shares it, lands next to it as
 * <session>.audio.<ext> / <session>.video.<ext> (MediaRecorder chunks).
 *
 * Sessions shorter than minFrames are deleted on close — the library
 * only keeps dances. Kept sessions are appended to sessions.jsonl.
 */
import { mkdirSync, openSync, writeSync, closeSync, unlinkSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXT = { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'audio/ogg': 'ogg' };

export class SessionRecorder {
  constructor(dir, { id, minFrames = 300 } = {}) {
    this.dir = dir;
    this.id = id;
    this.minFrames = minFrames;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.name = `${stamp}-${id}`;
    this.path = join(dir, `${this.name}.jsonl`);
    // Synchronous fds with a small line buffer: a closed session is fully
    // on disk when close() returns (the library indexes it right away).
    this.fd = openSync(this.path, 'a');
    this.buf = [];
    this.bufBytes = 0;
    this.media = new Map(); // kind -> { fd, path, bytes, mime }
    this.frames = 0;
    this.meta = { type: 'label', session: true, id, at: new Date().toISOString() };
    this.#line(this.meta);
  }

  #line(obj) {
    const line = JSON.stringify(obj) + '\n';
    this.buf.push(line);
    this.bufBytes += line.length;
    if (this.bufBytes > 64 * 1024) this.#flush();
  }

  #flush() {
    if (!this.buf.length || this.fd === null) return;
    writeSync(this.fd, this.buf.join(''));
    this.buf.length = 0;
    this.bufBytes = 0;
  }

  /** Extra provenance (room, sharing levels, camera size…) — merged into the session label. */
  label(obj) {
    Object.assign(this.meta, obj);
    this.#line({ type: 'label', ...obj });
  }

  frame(frame) {
    this.frames++;
    this.#line({ t: Math.round(frame.t), k: Array.from(frame.keypoints, (v) => +v.toFixed(4)) });
  }

  tempo({ t, bpm, confidence, musicBpm = 0, musicConfidence = 0 }) {
    this.#line({ type: 'tempo', t: Math.round(t), bpm: +bpm.toFixed(1), confidence: +confidence.toFixed(2),
      musicBpm: +musicBpm.toFixed(1), musicConfidence: +musicConfidence.toFixed(2) });
  }

  music(batch) {
    if (!Array.isArray(batch.e)) return;
    this.#line({ type: 'music', t0: Math.round(batch.t0 ?? 0), hz: batch.hz ?? 30, e: batch.e.map((v) => +(+v).toFixed(3)), ...(batch.from === 'room' ? { from: 'room' } : {}) });
  }

  /** A MediaRecorder chunk: kind 'audio' | 'video', mime like 'audio/webm;codecs=opus'. */
  mediaChunk(kind, mime, buf) {
    if (kind !== 'audio' && kind !== 'video') return;
    let m = this.media.get(kind);
    if (!m) {
      const ext = EXT[String(mime).split(';')[0]] ?? 'bin';
      const path = join(this.dir, `${this.name}.${kind}.${ext}`);
      m = { fd: openSync(path, 'a'), path, bytes: 0, mime };
      this.media.set(kind, m);
      this.label({ [`${kind}File`]: `${this.name}.${kind}.${ext}`, [`${kind}Mime`]: mime });
    }
    m.bytes += buf.length;
    writeSync(m.fd, buf);
  }

  /**
   * Finish. Returns { path, kept, frames }. Short sessions (someone opened
   * the app and left) are removed; kept ones are listed in sessions.jsonl.
   */
  close(extra = {}) {
    const kept = this.frames >= this.minFrames;
    this.#flush();
    closeSync(this.fd);
    this.fd = null;
    for (const m of this.media.values()) closeSync(m.fd);
    if (!kept) {
      for (const p of [this.path, ...[...this.media.values()].map((m) => m.path)]) {
        try { if (existsSync(p)) unlinkSync(p); } catch { /* best effort */ }
      }
      return { path: this.path, kept: false, frames: this.frames };
    }
    const summary = {
      name: this.name, path: this.path, frames: this.frames, ...this.meta, ...extra,
      media: Object.fromEntries([...this.media].map(([k, m]) => [k, { file: m.path, bytes: m.bytes, mime: m.mime }])),
      closedAt: new Date().toISOString(),
    };
    delete summary.type;
    appendFileSync(join(this.dir, 'sessions.jsonl'), JSON.stringify(summary) + '\n');
    return { path: this.path, kept: true, frames: this.frames };
  }
}
