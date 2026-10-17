/**
 * DJ schedule: rooms booked in advance (see src/net/schedule.js for what a
 * booking is). Kept in one JSON file so bookings survive restarts and
 * deploys; sets that have ended are dropped. There are no accounts: a
 * booking comes back with a secret token, and whoever holds it (the phone
 * that booked) can cancel the set.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkBooking, endOf, overlaps } from '../src/net/schedule.js';

const MAX_BOOKINGS = 500;

export class Schedule {
  /** file: JSON path, or null to keep bookings in memory only (tests). */
  constructor(file = null, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    this.bookings = []; // [{ id, token, dj, room, start, minutes, setInfo, bio, link, createdAt }]
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(saved)) this.bookings = saved;
      } catch (e) {
        if (e.code !== 'ENOENT') log(`schedule: could not read ${file}: ${e.message}`);
      }
    }
    this.prune();
  }

  /** Drop sets that have ended. → true if any were dropped. */
  prune(now = Date.now()) {
    const before = this.bookings.length;
    this.bookings = this.bookings.filter((b) => endOf(b) > now);
    if (this.bookings.length === before) return false;
    this.#save();
    return true;
  }

  /** What everyone may see: soonest first, no tokens. */
  list(now = Date.now()) {
    return this.bookings
      .filter((b) => endOf(b) > now)
      .sort((a, b) => a.start - b.start)
      .map(({ token, createdAt, ...pub }) => pub);
  }

  /** → { booking, token } or { error }. */
  book(raw, now = Date.now()) {
    this.prune(now);
    const { booking, error } = checkBooking(raw, now);
    if (error) return { error };
    if (this.bookings.length >= MAX_BOOKINGS) return { error: 'The schedule is full right now — try again later.' };
    const clash = this.bookings.find((b) => b.room === booking.room && overlaps(b, booking));
    if (clash) return { error: `${clash.dj} already has the room “${booking.room}” at that time.` };
    const entry = { id: randomUUID().slice(0, 8), token: randomUUID(), ...booking, createdAt: now };
    this.bookings.push(entry);
    this.#save();
    const { token, createdAt, ...pub } = entry;
    return { booking: pub, token };
  }

  /** Cancel with the token handed out at booking. → true if it was removed. */
  cancel(id, token) {
    const i = this.bookings.findIndex((b) => b.id === id && b.token === token);
    if (i < 0) return false;
    this.bookings.splice(i, 1);
    this.#save();
    return true;
  }

  #save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.bookings, null, 1));
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`schedule: could not save ${this.file}: ${e.message}`);
    }
  }
}
