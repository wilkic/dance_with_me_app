/**
 * The invite link: https://dance.wilkinscoffee.be/#invite=KEY shows the
 * private resident rooms (Free Mixter Mix, Wilkins-Mix). The key moves from
 * the address into this browser (so a home-screen shortcut keeps it) and is
 * sent to the dance server on every connect: { type: 'invite', key }.
 * Shared by the app, /schedule and the dance floor (same origin, same key).
 */
const STORE = 'dwm.inviteKey';

const read = () => { try { return localStorage.getItem(STORE); } catch { return null; } };
const write = (v) => { try { v ? localStorage.setItem(STORE, v) : localStorage.removeItem(STORE); } catch { /* storage unavailable */ } };

let key = read();

/** Take #invite=KEY from the address (out of the URL). → true if there was one. */
function take() {
  const k = new URLSearchParams(location.hash.slice(1)).get('invite');
  if (!k) return false;
  key = k.slice(0, 64);
  write(key);
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
take();

/** The message to send on connect, or null without an invite. */
export const inviteMsg = () => (key ? { type: 'invite', key } : null);

/** The server said the key is wrong: forget it. */
export function forgetInvite() { key = null; write(null); }

/** Opening the link on an already-open page: send(msg) with the new key. */
export function onInviteLink(send) {
  addEventListener('hashchange', () => { if (take()) send(inviteMsg()); });
}
