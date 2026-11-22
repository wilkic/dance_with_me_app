#!/usr/bin/env node
/**
 * Selector channels (issue #34): build a shortlist of Creative Commons
 * tracks from ccMixter for each tempo channel in channels.json.
 *
 *   node tools/music/ccmixter-shortlist.mjs [--per 24] [--depth 150] [--nc] [--refresh]
 *
 * Writes tools/music/out/shortlist.json and shortlist.html (shortlist-nc.*
 * with --nc, which adds CC BY-NC tracks: fine while the app earns nothing),
 * a review page
 * with tick boxes; "Copy picks" gives the chosen ids).
 *
 * f=js, not f=json: ccMixter's f=json also copies the whole body into an
 * X-JSON header, which overflows Node's header limit.
 *
 * Be a good guest: ccMixter's robots.txt asks bots to stay off /api/ and
 * its audio blocks hotlinking. So this runs rarely, by hand, one request
 * at a time with a pause, and caches every answer in tools/music/.cache
 * (--refresh ignores the cache). It never downloads audio.
 *
 * Tempo: a track fits a channel at its listed BPM, or "felt" at double or
 * half time (a 64 BPM adagio sits in a 128 channel), scored a bit lower.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, '.cache');
const OUT = join(HERE, 'out');
const API = 'https://ccmixter.org/api/query';
const PAUSE_MS = 1500;
const MIN_SEC = 90;
const MAX_SEC = 9 * 60;
const PER_ARTIST = 2; // per channel
const GENRE_SHARE = 0.35; // no genre takes more of a channel than this

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : Number(args[i + 1]);
};
const flag = (name) => args.includes(`--${name}`);
const PER = opt('per', 24);
const DEPTH = opt('depth', 150);
const NC = flag('nc');
const REFRESH = flag('refresh');
const NAME = NC ? 'shortlist-nc' : 'shortlist';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;

/** One API call, cached on disk by URL; at most one live call per PAUSE_MS. */
async function query(params) {
  const url = `${API}?${new URLSearchParams({ f: 'js', ...params })}`;
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (!REFRESH && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const wait = lastCall + PAUSE_MS - Date.now();
  if (wait > 0) await sleep(wait);
  for (let attempt = 1; ; attempt++) {
    lastCall = Date.now();
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'dance-with-me-shortlist/1 (occasional, cached)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // ccMixter writes some numbers with leading zeros ("bpm" : 097), which isn't JSON.
      const text = (await res.text()).replace(/("[\w-]+"\s*:\s*)0+(\d)/g, '$1$2');
      const data = JSON.parse(text);
      await writeFile(file, JSON.stringify(data));
      return data;
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      process.stderr.write(`  retry ${attempt} after ${e.message}\n`);
      await sleep(5000 * attempt);
    }
  }
}

/** Licence family from the licence URL (the source of truth, not the label). */
function licence(url = '') {
  if (/publicdomain\/zero|publicdomain\/mark/.test(url)) return 'CC0';
  const m = url.match(/licenses\/([a-z-]+)\//);
  return m ? `CC ${m[1].toUpperCase()}` : null;
}
const OPEN = new Set(['CC0', 'CC BY', 'CC BY-SA']);
const allowed = (lic) => OPEN.has(lic) || (NC && (lic === 'CC BY-NC' || lic === 'CC BY-NC-SA'));

const seconds = (ps = '') => {
  const p = String(ps).split(':').map(Number);
  return p.some(Number.isNaN) ? 0 : p.reduce((a, b) => a * 60 + b, 0);
};

/** A raw ccMixter upload → the fields we keep, or null if unusable. */
function track(u) {
  const file = (u.files || []).find((f) => f.file_format_info?.['media-type'] === 'audio' && /mp3/.test(f.file_format_info?.['default-ext'] || ''));
  const bpm = Number(u.upload_extra?.bpm);
  if (!file || !bpm || u.upload_extra?.nsfw) return null;
  const lic = licence(u.license_url);
  return {
    id: u.upload_id,
    title: u.upload_name,
    artist: u.user_real_name || u.user_name,
    user: u.user_name,
    featuring: u.upload_extra?.featuring || '',
    bpm,
    sec: seconds(file.file_format_info?.ps),
    tags: (u.upload_tags || '').split(',').filter(Boolean),
    pick: Boolean(u.upload_extra?.edpicks) || /editorial_pick/.test(u.upload_tags || ''),
    scores: Number(u.upload_num_scores) || 0,
    licence: lic,
    licenceName: u.license_name,
    licenceUrl: u.license_url,
    page: u.file_page_url,
    artistPage: u.artist_page_url,
    file: file.file_name,
    // The real address: contest entries live under /contests/<contest>/<user>/, not /content/<user>/.
    url: file.download_url,
    year: (u.upload_date_format || '').match(/\b(19|20)\d\d\b/)?.[0] || '',
  };
}

/** How a track's tempo fits a band: { felt, fit } or null. */
function tempoFit(bpm, [lo, hi]) {
  for (const [mult, fit] of [[1, 1], [2, 0.75], [0.5, 0.75]]) {
    const felt = bpm * mult;
    if (felt >= lo && felt <= hi) return { felt: Math.round(felt), mult, fit };
  }
  return null;
}

function score(t, fit, taste, channel) {
  const tagSet = new Set(t.tags);
  const tasteLift = Math.min(3, [...tagSet].reduce((a, tag) => a + (taste.weights[tag] || 0), 0));
  const popularity = Math.log1p(t.scores) / Math.log1p(100); // ~1 at 100 ratings
  const mid = (channel.bpm[0] + channel.bpm[1]) / 2;
  const centre = 1 - Math.min(1, Math.abs(fit.felt - mid) / (channel.bpm[1] - channel.bpm[0])) * 0.2;
  return (1 + tasteLift) * (0.5 + popularity + (t.pick ? 0.6 : 0)) * fit.fit * centre;
}

async function main() {
  const conf = JSON.parse(await readFile(join(HERE, 'channels.json'), 'utf8'));
  await mkdir(CACHE, { recursive: true });
  await mkdir(OUT, { recursive: true });
  const avoid = new Set(conf.taste.avoid);
  const lics = NC ? conf.licencesWithNc : conf.licences;

  // Every genre any channel wants, fetched once per licence, best-ranked first.
  const genres = [...new Set(conf.channels.flatMap((c) => c.genres))];
  const byGenre = new Map(); // genre → Map(id → track)
  let calls = 0;
  for (const g of genres) {
    const found = new Map();
    for (const lic of lics) {
      const rows = await query({ tags: g, lic, sort: 'rank', limit: String(DEPTH) });
      calls++;
      for (const u of Array.isArray(rows) ? rows : []) {
        const t = track(u);
        if (!t || !allowed(t.licence) || t.sec < MIN_SEC || t.sec > MAX_SEC) continue;
        if (t.tags.some((x) => avoid.has(x))) continue;
        found.set(t.id, t);
      }
    }
    byGenre.set(g, found);
    process.stderr.write(`${g.padEnd(12)} ${String(found.size).padStart(4)} usable\n`);
  }

  // Fill channels; a track lands in one channel only (the first that takes it).
  const used = new Set();
  const out = [];
  for (const ch of conf.channels) {
    const cands = new Map(); // id → { t, genre, fit, score }
    for (const g of ch.genres) {
      for (const t of byGenre.get(g)?.values() ?? []) {
        const fit = tempoFit(t.bpm, ch.bpm);
        if (!fit || used.has(t.id)) continue;
        const s = score(t, fit, conf.taste, ch);
        const prev = cands.get(t.id);
        // Credit the track to the channel genre the taste likes most.
        if (!prev || (conf.taste.weights[g] || 0) > (conf.taste.weights[prev.genre] || 0)) cands.set(t.id, { t, genre: g, fit, score: s });
      }
    }
    // Round-robin over genres, best score first within each, so the channel mixes.
    const queues = ch.genres.map((g) => [...cands.values()].filter((c) => c.genre === g).sort((a, b) => b.score - a.score));
    const picks = [];
    const perArtist = new Map();
    const take = (c) => {
      const n = perArtist.get(c.t.user) || 0;
      if (n >= PER_ARTIST || used.has(c.t.id)) return false;
      perArtist.set(c.t.user, n + 1);
      used.add(c.t.id);
      picks.push(c);
      return true;
    };
    // A thin channel ends up shorter rather than all one genre.
    const cap = Math.max(3, Math.ceil(PER * GENRE_SHARE));
    const perGenre = new Map();
    for (let progress = true; picks.length < PER && progress; ) {
      progress = false;
      for (const q of queues) {
        if (!q.length || (perGenre.get(q[0].genre) || 0) >= cap) continue;
        while (q.length && picks.length < PER) {
          const c = q.shift();
          if (take(c)) { perGenre.set(c.genre, (perGenre.get(c.genre) || 0) + 1); progress = true; break; }
        }
      }
    }
    const reserve = queues.flat().filter((c) => !used.has(c.t.id)).sort((a, b) => b.score - a.score).slice(0, 10);
    const row = (c) => ({ ...c.t, genre: c.genre, felt: c.fit.felt, mult: c.fit.mult, score: Number(c.score.toFixed(2)) });
    const mix = {};
    for (const p of picks) mix[p.genre] = (mix[p.genre] || 0) + 1;
    out.push({
      ...ch,
      candidates: cands.size,
      minutes: Math.round(picks.reduce((a, p) => a + p.t.sec, 0) / 60),
      mix,
      tracks: picks.sort((a, b) => a.fit.felt - b.fit.felt).map(row),
      reserve: reserve.map(row),
    });
    process.stderr.write(`→ ${ch.name}: ${picks.length} picked of ${cands.size} in ${ch.bpm.join('-')} BPM\n`);
  }

  const result = {
    made: new Date().toISOString(),
    source: 'ccMixter (ccmixter.org), Creative Commons',
    licences: NC ? 'CC BY, CC BY-SA, CC0 and NC' : 'CC BY, CC BY-SA, CC0',
    story: conf.story,
    apiCalls: calls,
    channels: out,
  };
  await writeFile(join(OUT, `${NAME}.json`), JSON.stringify(result, null, 2));
  await writeFile(join(OUT, `${NAME}.html`), page(result));
  process.stderr.write(`\nwrote ${join(OUT, `${NAME}.json`)}\n      ${join(OUT, `${NAME}.html`)}\n`);
}

// ---------------------------------------------------------------- review page

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function page(r) {
  const total = r.channels.reduce((a, c) => a + c.tracks.length, 0);
  const rows = (list, chId, reserve) => list.map((t) => `
      <tr${reserve ? ' class="reserve"' : ''}>
        <td><input type="checkbox" data-id="${t.id}" data-ch="${chId}"${reserve ? '' : ' checked'} aria-label="Pick"></td>
        <td class="num">${t.felt}${t.mult !== 1 ? `<span class="felt" title="listed at ${t.bpm} BPM, felt at ${t.mult === 2 ? 'double' : 'half'} time">${t.mult === 2 ? '×2' : '½'}</span>` : ''}</td>
        <td><a href="${esc(t.page)}" target="_blank" rel="noopener">${esc(t.title)}</a><div class="sub">${esc(t.artist)}${t.featuring ? ` · ft. ${esc(t.featuring)}` : ''}${t.year ? ` · ${t.year}` : ''}</div></td>
        <td><span class="tag">${esc(t.genre.replace(/_/g, ' '))}</span>${t.pick ? '<span class="tag pick">ed. pick</span>' : ''}</td>
        <td class="num">${mmss(t.sec)}</td>
        <td><a class="lic" href="${esc(t.licenceUrl)}" target="_blank" rel="noopener">${esc(t.licence)}</a></td>
      </tr>`).join('');
  const sections = r.channels.map((c) => `
  <section id="${c.id}">
    <header>
      <div class="band">${c.bpm[0]}–${c.bpm[1]} <small>BPM</small></div>
      <div><h2>${esc(c.name)}</h2><p class="story">${esc(c.story)}</p>
      <p class="meta">${c.tracks.length} tracks · ${c.minutes} min · from ${c.candidates} candidates · ${Object.entries(c.mix).map(([g, n]) => `${esc(g.replace(/_/g, ' '))} ${n}`).join(', ')}</p></div>
    </header>
    <div class="scroll"><table>
      <thead><tr><th></th><th>BPM</th><th>Track</th><th>Found as</th><th>Length</th><th>Licence</th></tr></thead>
      <tbody>${rows(c.tracks, c.id, false)}${c.reserve.length ? `<tr class="sep"><td colspan="6">Reserves</td></tr>${rows(c.reserve, c.id, true)}` : ''}</tbody>
    </table></div>
  </section>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="claude:viewport-fit-sides" content="cover">
<title>Selector Channels Shortlist</title>
<style>
:root{--bg:#f7f5f0;--card:#fff;--ink:#1d1b18;--sub:#6b665d;--line:#e4dfd4;--accent:#b4451f;--tag:#efe9dd;--pick:#f6dfb8}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#15140f;--card:#1e1d18;--ink:#ece8df;--sub:#a29c90;--line:#34322a;--accent:#f0875c;--tag:#2c2a23;--pick:#5a4420;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#15140f;--card:#1e1d18;--ink:#ece8df;--sub:#a29c90;--line:#34322a;--accent:#f0875c;--tag:#2c2a23;--pick:#5a4420;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding-block:24px 96px;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
h1{font-size:28px;margin:0 0 6px;text-wrap:balance}.lede{color:var(--sub);max-width:70ch}
nav{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0 8px}nav a{padding:4px 10px;border:1px solid var(--line);border-radius:99px;color:var(--ink);text-decoration:none;font-size:13px}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:20px 0;padding:16px}
header{display:flex;gap:16px;align-items:flex-start}.band{font-size:26px;font-weight:700;color:var(--accent);white-space:nowrap;font-variant-numeric:tabular-nums}.band small{font-size:12px;color:var(--sub)}
h2{margin:0;font-size:19px}.story{margin:4px 0}.meta{margin:0;color:var(--sub);font-size:13px}
.scroll{overflow-x:auto;margin-top:12px}table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;color:var(--sub);font-weight:500;font-size:12px;border-bottom:1px solid var(--line);padding:6px}
td{padding:6px;border-bottom:1px solid var(--line);vertical-align:top}.num{font-variant-numeric:tabular-nums;white-space:nowrap}
a{color:var(--accent)}.sub{color:var(--sub);font-size:12px}.tag{display:inline-block;background:var(--tag);border-radius:6px;padding:1px 6px;font-size:12px;margin:0 4px 2px 0;white-space:nowrap}.tag.pick{background:var(--pick)}
.felt{font-size:11px;color:var(--sub);margin-left:3px}.lic{font-size:12px;white-space:nowrap}
tr.reserve{opacity:.65}tr.sep td{color:var(--sub);font-size:12px;padding-top:14px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px max(16px,env(safe-area-inset-right,0px)) calc(10px + env(safe-area-inset-bottom,0px)) max(16px,env(safe-area-inset-left,0px));display:flex;gap:12px;align-items:center;justify-content:center}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer}
@media (max-width:600px){header{flex-direction:column;gap:4px}}
</style></head><body><main>
<h1>Selector channels: shortlist</h1>
<p class="lede">${esc(r.story)}</p>
<p class="sub">${total} tracks from ${esc(r.source)} · licences: ${esc(r.licences)} · made ${esc(r.made.slice(0, 16).replace('T', ' '))} UTC. Titles are here for review and credits only, not for the dance view. Listen on each track's ccMixter page (their audio can't be played from here). BPM is the uploader's own figure; ×2 / ½ means felt at double or half time.</p>
<nav>${r.channels.map((c) => `<a href="#${c.id}">${esc(c.name)} · ${c.bpm[0]}–${c.bpm[1]}</a>`).join('')}</nav>
${sections}
</main>
<div class="bar"><span id="count"></span><button id="copy">Copy picks</button></div>
<script>
const KEY='selector-picks';const boxes=[...document.querySelectorAll('input[data-id]')];
try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(s)boxes.forEach(b=>b.checked=s.includes(b.dataset.ch+':'+b.dataset.id));}catch(e){}
const picks=()=>boxes.filter(b=>b.checked).map(b=>b.dataset.ch+':'+b.dataset.id);
const upd=()=>{document.getElementById('count').textContent=picks().length+' picked';try{localStorage.setItem(KEY,JSON.stringify(picks()));}catch(e){}};
boxes.forEach(b=>b.addEventListener('change',upd));upd();
document.getElementById('copy').onclick=async()=>{const by={};picks().forEach(p=>{const[c,i]=p.split(':');(by[c]=by[c]||[]).push(Number(i));});const t=JSON.stringify(by);try{await navigator.clipboard.writeText(t);document.getElementById('copy').textContent='Copied';}catch(e){const a=document.createElement('textarea');a.value=t;a.rows=3;a.style.width='60%';document.querySelector('.bar').append(a);a.select();}};
</script></body></html>`;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
