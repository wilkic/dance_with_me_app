#!/usr/bin/env node
/**
 * Selector channels (issue #34): make the channel playlists the dance server
 * plays, from what's in tools/music/opus (after to-opus.sh).
 *
 *   node tools/music/publish.mjs
 *
 * Writes into tools/music/opus/ (which deploy.sh music copies to the server):
 *   channels.json   [{ id, name, story, bpm: [lo, hi], daily: { at, minutes, tz }, setInfo, bio,
 *                      seconds, tracks: [{ file, sec, bpm }],   ← all day: every track
 *                      set: { seconds, tracks } }]              ← during the daily set
 *                   — the residents (see channels.json)
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

// Every channel's playlist: a pool of tracks the residents play from.
const pools = conf.channels.map((c) => ({ ...c, tracks: mixOrder(manifest.filter((t) => t.ch === c.id), c.id) })).filter((c) => c.tracks.length);
const entry = (t) => ({ file: t.opus, sec: t.sec, bpm: t.felt });
const total = (list) => list.reduce((a, t) => a + t.sec, 0);

// Only residents are published: a room with a resident DJ and a daily set.
// All day it loops every downloaded track, one channel after another in
// tempo order (so the pulse holds for a while); during the daily set it
// plays the set: tracks from its pools by genre and tempo, from the top.
// A resident's set: tracks from its pools by genre and tempo, or every
// track when it names none (Free Mixter Mix, a 24-hour daily set). A
// `setOnly` resident (Wilkins-Mix) plays nothing outside its set.
const residents = conf.residents.list.map((r) => {
  const all = pools.flatMap((c) => c.tracks);
  const picked = r.from ? all.filter((t) => r.from.includes(t.ch) && r.genres.includes(t.genre) && t.felt >= r.bpm[0] && t.felt <= r.bpm[1]) : all;
  const set = r.from ? mixOrder(picked, r.id) : picked;
  const day = r.setOnly ? set : all;
  return {
    id: r.id,
    name: r.dj,
    story: r.setInfo,
    bpm: r.bpm,
    daily: r.daily,
    ...(r.setOnly ? { setOnly: true } : {}),
    setInfo: r.setInfo,
    bio: r.bio,
    seconds: total(day),
    tracks: day.map(entry),
    set: { seconds: total(set), tracks: set.map(entry) },
  };
}).filter((c) => c.tracks.length);
const channels = residents;

writeFileSync(join(OPUS, 'channels.json'), JSON.stringify({ story: conf.story, channels }, null, 2));

// ---------------------------------------------------------------- credits
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
const sections = pools.map((c) => `
<section id="${c.id}">
  <h2>${esc(c.name)} <span>${c.bpm[0]}–${c.bpm[1]} BPM</span></h2>
  <p class="story">${esc(c.story)}</p>
  <ul>${c.tracks.map((t) => `
    <li><a href="${esc(t.page)}" rel="noopener">${esc(t.title)}</a> by ${esc(t.artist)} · <a href="${esc(t.licenceUrl)}" rel="noopener license">${esc(t.licence)}</a></li>`).join('')}
  </ul>
</section>`).join('');
const residentNote = residents.map((r) => `<span id="${r.id}"></span>`).join('');

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
<p class="sub">The resident DJ rooms in <a href="https://dance.wilkinscoffee.be/">Dance With Me</a> play Creative Commons music from <a href="https://ccmixter.org/">ccMixter</a>. Free Mixter Mix is the open room: every day, all day long, it plays every track below, a channel at a time, and new tracks keep joining it. Other residents' daily sets pick from the same list. Thank you to every artist. Each track keeps its own licence; follow a track's link to hear, download or remix it.</p>
${residentNote}${sections}
</main></body></html>
`);

console.log(`${residents.length} resident(s): ${residents.map((r) => `${r.id} all day ${r.tracks.length} tracks ${(r.seconds / 3600).toFixed(1)} h, set ${r.set.tracks.length} tracks ${(r.set.seconds / 60).toFixed(0)} min`).join("; ")} → ${OPUS}/channels.json, credits.html`);
