/**
 * Visit stats: daily totals, nothing about who (see /privacy/).
 *
 * No cookies, no IPs, no ids — just counters per day (Brussels time):
 *   app, schedule   page opens (the phone says so once per page load)
 *   phone, computer what kind of device opened the app
 *   ref             which site sent people there (host name only; 'direct'
 *                   when the browser doesn't say)
 *   danced          sessions that sent at least one pose (camera running)
 *   shared, joined  rooms opened / rooms joined
 *   music           room music started
 *   booked          DJ booking requests
 *   peak            most connections at once
 * Kept KEEP_DAYS days in one JSON file, written at most every SAVE_MS.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const KEEP_DAYS = 90;
const SAVE_MS = 30_000;
const MAX_REFS = 40; // distinct referring sites per day; the rest count as 'other'
const COUNTERS = ['app', 'schedule', 'phone', 'computer', 'danced', 'shared', 'joined', 'music', 'booked'];

/** 'YYYY-MM-DD' in Brussels. */
export const dayOf = (now = Date.now()) => new Date(now).toLocaleDateString('sv-SE', { timeZone: 'Europe/Brussels' });

/** A referrer → a bare host name ('direct' if none, null if it's junk). */
export function refHost(ref) {
  if (!ref) return 'direct';
  const host = String(ref).toLowerCase().replace(/^www\./, '').slice(0, 60);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) ? host : null;
}

export class Stats {
  /** file: JSON path, or null to keep counts in memory only (tests). */
  constructor(file = null, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.days = {}; // day -> { counters…, peak, ref: { host: n } }
    this.dirty = false;
    this.savedAt = 0;
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (saved && typeof saved === 'object') this.days = saved;
      } catch (e) {
        if (e.code !== 'ENOENT') log(`stats: could not read ${file}: ${e.message}`);
      }
    }
  }

  #today(now) {
    const d = dayOf(now);
    return (this.days[d] ??= { ...Object.fromEntries(COUNTERS.map((k) => [k, 0])), peak: 0, ref: {} });
  }

  /** One more of `what` (a COUNTERS name) today. */
  count(what, now = Date.now()) {
    if (!COUNTERS.includes(what)) return;
    const t = this.#today(now);
    t[what] = (t[what] ?? 0) + 1;
    this.dirty = true;
  }

  /** A page open: { page: 'app'|'schedule', ref, phone }. */
  visit({ page, ref, phone } = {}, now = Date.now()) {
    if (page !== 'app' && page !== 'schedule') return;
    this.count(page, now);
    const t = this.#today(now);
    if (page === 'app') t[phone ? 'phone' : 'computer']++;
    const host = refHost(ref);
    if (host) {
      const key = host in t.ref || Object.keys(t.ref).length < MAX_REFS ? host : 'other';
      t.ref[key] = (t.ref[key] ?? 0) + 1;
    }
  }

  /** Connections right now (keeps today's peak). */
  online(n, now = Date.now()) {
    const t = this.#today(now);
    if (n > t.peak) { t.peak = n; this.dirty = true; }
  }

  /** The last `n` days, newest first (days with nothing are included as zeros). */
  recent(n = 14, now = Date.now()) {
    const out = [];
    const [y, m, dd] = dayOf(now).split('-').map(Number);
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.UTC(y, m - 1, dd - i)).toISOString().slice(0, 10);
      out.push({ day: d, ...(this.days[d] ?? { ...Object.fromEntries(COUNTERS.map((k) => [k, 0])), peak: 0, ref: {} }) });
    }
    return out;
  }

  /** Drop old days and write the file if anything changed (call often; it throttles itself). */
  save(now = Date.now(), force = false) {
    if (!this.file || !this.dirty || (!force && now - this.savedAt < SAVE_MS)) return;
    const oldest = dayOf(now - KEEP_DAYS * 86_400_000);
    for (const d of Object.keys(this.days)) if (d < oldest) delete this.days[d];
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.days));
      renameSync(tmp, this.file);
      this.dirty = false;
      this.savedAt = now;
    } catch (e) {
      this.log(`stats: could not save ${this.file}: ${e.message}`);
    }
  }
}
