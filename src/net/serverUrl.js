/**
 * Where the dance server lives, shared by the phone app and the dance floor:
 *   ?server=wss://…   explicit URL
 *   ?server=1         Vite dev proxy (wss://<host>/ws → local server)
 *   ?server=0         off (fully offline, solo only)
 *   otherwise         VITE_SERVER_URL at build time, or the dev proxy
 */
/** The OBS (WHIP) address that goes with a dance-server URL: wss://host/ws → https://host/whip. */
export function whipUrl(serverUrl) {
  if (!serverUrl) return null;
  try {
    const u = new URL(serverUrl);
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
    u.pathname = u.pathname.replace(/\/ws\/?$/, '').replace(/\/$/, '') + '/whip';
    return u.href;
  } catch { return null; }
}

export function resolveServerUrl(params = new URLSearchParams(location.search)) {
  const p = params.get('server');
  if (p === '0') return null;
  if (p === '1') return `wss://${location.host}/ws`;
  if (p) return p;
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
  if (import.meta.env.DEV) return `wss://${location.host}/ws`;
  return null;
}
