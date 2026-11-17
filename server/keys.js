/**
 * Dance keys: recording without accounts.
 *
 * A dancer who wants to record asks for a key (after agreeing to what is
 * kept). The key is random, shown once, and theirs to write down; it goes
 * in the app's address as ?ai=KEY. There is no name, e-mail or password.
 *
 * What the server keeps per key, in <dir>/<id>/:
 *   meta.json        { createdAt, lastUsedAt }
 *   *.jsonl          the clips recorded with it (recorder.js)
 *   sessions.jsonl   one line per kept clip
 * <id> is a hash of the key, so the folder names are not keys: someone who
 * sees the disk cannot open anyone's dances in the app.
 *
 * A key and everything under it is deleted when its owner asks (remove),
 * or after EXPIRY_DAYS without being used (purge).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Crockford base32: no I, L, O or U, so a hand-copied key survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_CHARS = 20; // 100 bits

/** What someone typed or pasted → the 20 characters, or null if it can't be a key. */
export function normalizeKey(text) {
  if (typeof text !== 'string') return null;
  const k = text.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return k.length === KEY_CHARS && [...k].every((c) => ALPHABET.includes(c)) ? k : null;
}
/** ABCDE-FGHJK-MNPQR-STVWX: how a key is shown. */
export const formatKey = (k) => k.match(/.{5}/g).join('-');
const idOf = (k) => createHash('sha256').update(`dance-key:${k}`).digest('hex').slice(0, 32);

export class Keys {
  constructor(dir, { maxNewPerDay = 300, maxSeconds = 60 * 60, log = () => {}, now = () => Date.now() } = {}) {
    this.dir = dir;
    this.maxNewPerDay = maxNewPerDay; // across everyone: a full disk is the risk, not a guessed key
    this.maxSeconds = maxSeconds;     // of kept clips per key
    this.log = log;
    this.now = now;
    this.made = { day: '', n: 0 };
    this.touched = new Map(); // id -> when lastUsedAt was last written
  }

  #meta(id) {
    try { return JSON.parse(readFileSync(join(this.dir, id, 'meta.json'), 'utf8')); } catch { return null; }
  }

  /** A new key, or null when today's allowance is used up. */
  create() {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    if (this.made.day !== day) this.made = { day, n: 0 };
    if (this.made.n >= this.maxNewPerDay) return null;
    this.made.n++;
    const bytes = randomBytes(KEY_CHARS);
    const key = Array.from(bytes, (b) => ALPHABET[b % 32]).join('');
    const id = idOf(key);
    mkdirSync(join(this.dir, id), { recursive: true });
    const at = new Date(this.now()).toISOString();
    writeFileSync(join(this.dir, id, 'meta.json'), JSON.stringify({ createdAt: at, lastUsedAt: at }));
    this.log(`🔑 a dance key was made (${this.made.n} today)`);
    return { key: formatKey(key), id };
  }

  /** The id behind a key someone gave, or null if there is no such key. */
  find(text) {
    const k = normalizeKey(text);
    if (!k) return null;
    const id = idOf(k);
    return this.#meta(id) ? id : null;
  }

  /** Where this key's clips go. */
  clipDir(id) { return join(this.dir, id); }

  /** The key was used: its 30 days start again (written at most hourly). */
  touch(id) {
    const t = this.now();
    if (t - (this.touched.get(id) ?? 0) < 60 * 60 * 1000) return;
    const meta = this.#meta(id);
    if (!meta) return;
    this.touched.set(id, t);
    writeFileSync(join(this.dir, id, 'meta.json'), JSON.stringify({ ...meta, lastUsedAt: new Date(t).toISOString() }));
  }

  /** What is kept under a key: { clips, seconds, lastUsedAt, expiresAt, full }. */
  info(id) {
    const meta = this.#meta(id);
    if (!meta) return null;
    let clips = 0, seconds = 0;
    try {
      for (const line of readFileSync(join(this.dir, id, 'sessions.jsonl'), 'utf8').split('\n')) {
        if (!line) continue;
        try { const s = JSON.parse(line); clips++; seconds += s.seconds ?? 0; } catch { /* a torn line */ }
      }
    } catch { /* no clips yet */ }
    const last = Date.parse(meta.lastUsedAt) || this.now();
    return { clips, seconds: Math.round(seconds), lastUsedAt: meta.lastUsedAt, expiresAt: new Date(last + EXPIRY_DAYS * DAY_MS).toISOString(), full: seconds >= this.maxSeconds };
  }

  /** Delete a key and every clip under it. */
  remove(id) {
    if (!/^[0-9a-f]{32}$/.test(id)) return false;
    const had = existsSync(join(this.dir, id));
    rmSync(join(this.dir, id), { recursive: true, force: true });
    this.touched.delete(id);
    return had;
  }

  /** Delete every key not used for EXPIRY_DAYS. `inUse`: ids to leave alone (connected now). */
  purge(inUse = new Set()) {
    let ids = [];
    try { ids = readdirSync(this.dir).filter((d) => /^[0-9a-f]{32}$/.test(d)); } catch { return 0; }
    let gone = 0;
    for (const id of ids) {
      if (inUse.has(id)) continue;
      const meta = this.#meta(id);
      const last = Date.parse(meta?.lastUsedAt ?? meta?.createdAt ?? 0) || 0;
      if (this.now() - last > EXPIRY_DAYS * DAY_MS && this.remove(id)) gone++;
    }
    if (gone) this.log(`🔑 ${gone} dance key${gone > 1 ? 's' : ''} unused for ${EXPIRY_DAYS} days: deleted with their clips`);
    return gone;
  }
}
