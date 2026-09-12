/**
 * Where the dance server lives, shared by the phone app and the dance floor:
 *   ?server=wss://…   explicit URL
 *   ?server=1         Vite dev proxy (wss://<host>/ws → local server)
 *   ?server=0         off (fully offline, solo only)
 *   otherwise         VITE_SERVER_URL at build time, or the dev proxy
 */
export function resolveServerUrl(params = new URLSearchParams(location.search)) {
  const p = params.get('server');
  if (p === '0') return null;
  if (p === '1') return `wss://${location.host}/ws`;
  if (p) return p;
  if (import.meta.env.VITE_SERVER_URL) return import.meta.env.VITE_SERVER_URL;
  if (import.meta.env.DEV) return `wss://${location.host}/ws`;
  return null;
}
