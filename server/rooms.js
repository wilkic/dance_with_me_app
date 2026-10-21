/**
 * Dance rooms: named groups of sessions that see each other dance.
 *
 * A room exists exactly as long as it has members (no persistence — the
 * first to arrive creates it, the last to leave closes it). Its creator is
 * its host: the one who can play music to the room. The host is known by a
 * key their browser made (session.hostKey), so they get the role back
 * after a reconnect; index.js lets a booked DJ's token override it.
 * A room's tempo is its music's (index.js), never its dancers' movement.
 */
import { normalizeRoomName } from '../src/net/roomNames.js';

export class Rooms {
  constructor() {
    this.rooms = new Map(); // name -> Set<session>
    this.hostKeys = new Map(); // name -> the creator's hostKey (or null)
  }

  /**
   * Move a session into a room (leaving its current one). Returns
   * { name, created } or null if the name normalizes to nothing.
   */
  join(session, rawName) {
    const name = normalizeRoomName(rawName);
    if (!name) return null;
    if (session.room === name) return { name, created: false };
    this.leave(session);
    let members = this.rooms.get(name);
    const created = !members;
    if (created) {
      this.rooms.set(name, (members = new Set()));
      this.hostKeys.set(name, session.hostKey || null);
    }
    members.add(session);
    session.room = name;
    return { name, created };
  }

  /** Remove a session from its room; the room closes when it empties. */
  leave(session) {
    const name = session.room;
    if (!name) return null;
    const members = this.rooms.get(name);
    members?.delete(session);
    if (members && members.size === 0) {
      this.rooms.delete(name);
      this.hostKeys.delete(name);
    }
    session.room = null;
    return name;
  }

  /** Other sessions in the same room as `session` (empty if solo). */
  peersOf(session) {
    const members = session.room ? this.rooms.get(session.room) : null;
    if (!members) return [];
    const out = [];
    for (const s of members) if (s !== session) out.push(s);
    return out;
  }

  /** Was this session's browser the one that created the room? */
  createdBy(session, name = session.room) {
    const key = this.hostKeys.get(name);
    return !!key && session.hostKey === key;
  }

  members(name) {
    return [...(this.rooms.get(name) ?? [])];
  }

  get names() {
    return [...this.rooms.keys()];
  }
}
