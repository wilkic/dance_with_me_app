/**
 * DJ schedule: rooms booked in advance (see src/net/schedule.js for what a
 * booking is). Kept in one JSON file so bookings survive restarts and
 * deploys; sets that have ended are dropped.
 *
 * Every booking starts 'pending' and only shows publicly once an admin
 * approves it ('approved'); a rejected one stays 'rejected' (visible to
 * its DJ) until its time has passed. Pending requests don't hold the room:
 * clashes are checked against approved sets, at booking and again at
 * approval, so a prank request can't block a real DJ.
 *
 * There are no accounts: a booking comes back with a secret token, and
 * whoever holds it (the browser that booked) can see its status and
 * cancel it.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { checkBooking, endOf, overlaps } from '../src/net/schedule.js';

const MAX_APPROVED = 500;
const MAX_WAITING = 100; // pending requests at once

const pub = ({ token, ...b }) => b;

export class Schedule {
  /** file: JSON path, or null to keep bookings in memory only (tests). */
  constructor(file = null, { log = () => {} } = {}) {
    this.file = file;
    this.log = log;
    // [{ id, token, status, dj, room, start, minutes, setInfo, bio, link, createdAt }]
    this.bookings = [];
    if (file) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8'));
        if (Array.isArray(saved)) this.bookings = saved.map((b) => ({ status: 'approved', ...b }));
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

  #live(now, status) {
    return this.bookings
      .filter((b) => endOf(b) > now && (!status || b.status === status))
      .sort((a, b) => a.start - b.start);
  }

  /** What everyone may see: approved sets, soonest first, no tokens. */
  list(now = Date.now()) {
    return this.#live(now, 'approved').map(pub);
  }

  /** The admin's queue: requests waiting for a decision. */
  waiting(now = Date.now()) {
    return this.#live(now, 'pending').map(pub);
  }

  /** A DJ's own bookings, any status: tokens = { [id]: token }. */
  mine(tokens, now = Date.now()) {
    if (!tokens || typeof tokens !== 'object') return [];
    return this.#live(now).filter((b) => tokens[b.id] === b.token).map(pub);
  }

  #clash(booking) {
    return this.bookings.find((b) => b.status === 'approved' && b.id !== booking.id && b.room === booking.room && overlaps(b, booking));
  }

  /** A booking request → { booking, token } (pending) or { error }. */
  book(raw, now = Date.now()) {
    this.prune(now);
    const { booking, error } = checkBooking(raw, now);
    if (error) return { error };
    if (this.bookings.filter((b) => b.status === 'pending').length >= MAX_WAITING) {
      return { error: 'Too many requests are waiting for approval — try again later.' };
    }
    const clash = this.#clash(booking);
    if (clash) return { error: `${clash.dj} already has the room “${booking.room}” at that time.` };
    const entry = { id: randomUUID().slice(0, 8), token: randomUUID(), status: 'pending', ...booking, createdAt: now };
    this.bookings.push(entry);
    this.#save();
    return { booking: pub(entry), token: entry.token };
  }

  /** Admin: publish a pending request. → { booking } or { error }. */
  approve(id, now = Date.now()) {
    const b = this.bookings.find((x) => x.id === id && endOf(x) > now);
    if (!b) return { error: 'That request is gone (cancelled, or its time has passed).' };
    if (b.status === 'approved') return { booking: pub(b) };
    const clash = this.#clash(b);
    if (clash) return { error: `${clash.dj} already has “${b.room}” at that time — reject this one.` };
    if (this.list(now).length >= MAX_APPROVED) return { error: 'The schedule is full.' };
    b.status = 'approved';
    this.#save();
    return { booking: pub(b) };
  }

  /** Admin: turn a request down (its DJ sees "not approved"). → true if found. */
  reject(id) {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) return false;
    b.status = 'rejected';
    this.#save();
    return true;
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
