/**
 * /key — what is kept under a dance key, and deleting it (server/keys.js).
 * Talks to the dance server over the app's WebSocket: 'ai-key' with
 * { key } → { ok, clips, seconds, expiresAt } and { key, forget } →
 * { forgotten }. Nothing is saved in this browser.
 */
import { WebSocketTransport } from './net/poseChannel.js';
import { resolveServerUrl } from './net/serverUrl.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const url = resolveServerUrl(params);
const link = url ? new WebSocketTransport(url) : null;
let online = false;
let keysHere = false;

function say(text, bad = false) {
  $('result').textContent = text;
  $('result').classList.toggle('bad', bad);
}
function ready() {
  const ok = online && keysHere;
  for (const id of ['btn-show', 'btn-delete', 'btn-yes']) $(id).disabled = !ok;
  if (!link) say('No dance server is configured here.', true);
  else if (!online) say('Connecting to the dance server…');
  else if (!keysHere) say('This dance server has no dance keys.', true);
  else if ($('result').textContent.startsWith('Connecting')) say('');
}
const ask = (extra = {}) => {
  const key = $('key').value.trim();
  if (!key) return say('Type or paste your key first.', true);
  link.sendJSON({ type: 'ai-key', key, ...extra });
};

if (link) {
  link.onStatus = (state) => { online = state === 'open'; if (!online) keysHere = false; ready(); };
  link.onMessage = (msg) => {
    if (msg.type === 'welcome') { keysHere = msg.keys === true; ready(); }
    if (msg.type !== 'ai-key') return;
    if (msg.forgotten) {
      $('key').value = '';
      say('Deleted: the key and every clip under it are gone.');
    } else if (msg.ok) {
      const mins = Math.floor(msg.seconds / 60), secs = msg.seconds % 60;
      const until = new Date(msg.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
      say(`${msg.clips} clip${msg.clips === 1 ? '' : 's'} kept (${mins}:${String(secs).padStart(2, '0')} of dancing). If the key isn't used again, everything is deleted on ${until}.`);
    } else if (msg.reason === 'unknown') {
      say('No such key. It may already have been deleted (keys go after 30 days without use).', true);
    } else {
      say('Too many tries. Reload the page and try again.', true);
    }
  };
}
// Looking a key up counts as using it, so it isn't done without a tap.
$('key').value = params.get('ai') || '';
$('btn-show').addEventListener('click', () => { $('confirm').classList.add('hidden'); ask(); });
$('btn-delete').addEventListener('click', () => {
  if (!$('key').value.trim()) return say('Type or paste your key first.', true);
  $('confirm').classList.remove('hidden');
});
$('btn-no').addEventListener('click', () => $('confirm').classList.add('hidden'));
$('btn-yes').addEventListener('click', () => { $('confirm').classList.add('hidden'); ask({ forget: true }); });
ready();
