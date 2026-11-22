#!/usr/bin/env node
/**
 * Selector channels (issue #34): make the channel playlists the dance server
 * plays, from what's in tools/music/opus (after to-opus.sh).
 *
 *   node tools/music/publish.mjs
 *
 * Writes into tools/music/opus/ (which deploy.sh music copies to the server):
 *   channels.json   [{ id, name, story, bpm: [lo, hi], daily: { at, minutes, tz }, setInfo, bio,
 *                      seconds, tracks: [{ file, sec, bpm }] }] — the residents (see channels.json)
 *                   — no titles: the dance view shows the channel and its BPM only
 *   credits.html    every track's artist, title, licence and ccMixter page (CC BY asks for this)
 *
 * Playlist order is a fixed shuffle per channel that keeps the same genre
 * and the same artist from playing twice in a row, so the channel mixes.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPUS = join(HERE, 'opus');
const conf = JSON.parse(readFileSync(join(HERE, 'channels.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(OPUS, 'manifest.json'), 'utf8')).filter((t) => t.opus && existsSync(join(OPUS, t.opus)));

/** A small seeded random generator, so the order is the same on every run. */
function rng(seed) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function mixOrder(tracks, seed) {
  const rand = rng(seed);
  const pool = [...tracks].sort(() => rand() - 0.5);
  const out = [];
  while (pool.length) {
    const prev = out[out.length - 1];
    let i = pool.findIndex((t) => !prev || (t.genre !== prev.genre && t.artist !== prev.artist));
    if (i < 0) i = 0;
    out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// Only residents are published: a room with a resident DJ, its playlist
// drawn from the channels' tracks by genre and tempo, and its daily set.
const residents = conf.residents.list.map((r) => {
  const pool = manifest.filter((t) => r.from.includes(t.ch) && r.genres.includes(t.genre) && t.felt >= r.bpm[0] && t.felt <= r.bpm[1]);
  const tracks = mixOrder(pool, r.id);
  return {
    id: r.id,
    name: r.dj,
    story: r.setInfo,
    bpm: r.bpm,
    daily: r.daily,
    setInfo: r.setInfo,
    bio: r.bio,
    seconds: tracks.reduce((a, t) => a + t.sec, 0),
    tracks: tracks.map((t) => ({ file: t.opus, sec: t.sec, bpm: t.felt })),
  };
}).filter((c) => c.tracks.length);
const channels = residents;

writeFileSync(join(OPUS, 'channels.json'), JSON.stringify({ story: conf.story, channels }, null, 2));

// ---------------------------------------------------------------- credits
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const byFile = new Map(manifest.map((t) => [t.opus, t]));
const sections = channels.map((c) => `
<section id="${c.id}">
  <h2>${esc(c.name)} <span>${c.bpm[0]}–${c.bpm[1]} BPM</span></h2>
  <p class="story">${esc(c.story)}</p>
  <ul>${c.tracks.map((x) => {
    const t = byFile.get(x.file);
    return `
    <li><a href="${esc(t.page)}" rel="noopener">${esc(t.title)}</a> by ${esc(t.artist)} · <a href="${esc(t.licenceUrl)}" rel="noopener license">${esc(t.licence)}</a></li>`;
  }).join('')}
  </ul>
</section>`).join('');

writeFileSync(join(OPUS, 'credits.html'), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dance With Me · Music credits</title>
<style>
:root{--bg:#fbfaf7;--ink:#1c1b19;--sub:#6a655c;--line:#e6e1d6;--accent:#8a3ccf}
@media (prefers-color-scheme:dark){:root{--bg:#141318;--ink:#ecebef;--sub:#a29fae;--line:#2c2a33;--accent:#c79bf0}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-left)) 48px}
h1{font-size:24px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 4px}h2 span{color:var(--sub);font-weight:400;font-size:14px}
.story,.sub{color:var(--sub)}ul{padding-left:18px}li{margin:4px 0}a{color:var(--accent)}
section{border-top:1px solid var(--line)}
</style></head><body><main>
<h1>Music credits</h1>
<p class="sub">The resident rooms in <a href="https://dance.wilkinscoffee.be/">Dance With Me</a> play Creative Commons music from <a href="https://ccmixter.org/">ccMixter</a>. Thank you to every artist below. Each track keeps its own licence; follow a track's link to hear, download or remix it.</p>
${sections}
</main></body></html>
`);

console.log(`${channels.length} channels, ${channels.reduce((a, c) => a + c.tracks.length, 0)} tracks, ${(channels.reduce((a, c) => a + c.seconds, 0) / 3600).toFixed(1)} h → ${OPUS}/channels.json, credits.html`);
