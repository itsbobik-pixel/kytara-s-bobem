// Statické stránky písniček pro Google (SEO): pisen/<slug>/index.html + pisen/index.html + sitemap.xml
// Na stránce je jen název, interpret, tónina, kapo, akordy a jejich postup po částech – NIKDY text písně.
// Spuštění: node helper/build_pages.mjs   (čte veřejné + schválené songy přes publishable key z config.js)
// Běží i v GitHub Action (.github/workflows/pages.yml) – jednou denně + ručně.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://playalong.cz';
const OUT = path.join(ROOT, 'pisen');
const cfg = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
const URL_ = /supabaseUrl:\s*'([^']+)'/.exec(cfg)[1];
const KEY = /supabaseKey:\s*'(sb_publishable_[^']+)'/.exec(cfg)[1];

// ---------- hudební teorie (stejně jako app.js: křížky, mezinárodní B) ----------
const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const mod = n => ((n % 12) + 12) % 12;
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
const chordName = c => N[mod(c.root)] + (c.q || '') + (c.bass != null ? '/' + N[mod(c.bass)] : '');
const keyName = k => N[mod(k.root)] + (k.minor ? 'm' : '');
const relKey = k => k.minor ? { root: mod(k.root + 3), minor: false } : { root: mod(k.root - 3), minor: true };
const degreeOf = (root, k) => (k.minor ? MINOR : MAJOR).indexOf(mod(root - k.root));
const SEC = { intro: 'Intro', verse: 'Sloka', pre: 'Předrefrén', chorus: 'Refrén', bridge: 'Bridge', inter: 'Mezihra', solo: 'Sólo', outro: 'Outro' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slugify = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'pisen';
const day = iso => String(iso).slice(0, 10);

async function fetchSongs() {
  const sel = 'id,title,artist,created_at,updated_at,key:data->key,capo:data->capo,lines:data->lines,yt:data->sync->>yt,dur:data->sync->>dur';
  const r = await fetch(`${URL_}/rest/v1/songs?select=${sel}&is_public=eq.true&approved=eq.true&order=artist,title`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

/** části písně s postupem akordů (bez textu); stejné části za sebou se sloučí na „2×“ */
function sections(song) {
  const blocks = [];
  let cur = null;
  for (const ln of song.lines || []) {
    if (ln.section || !cur) { cur = { type: ln.section || null, chords: [] }; blocks.push(cur); }
    for (const c of [...(ln.chords || [])].sort((a, b) => a.pos - b.pos)) {
      const name = chordName(c);
      if (cur.chords[cur.chords.length - 1]?.name !== name) cur.chords.push({ name, root: c.root });
    }
  }
  const out = [];
  for (const b of blocks.filter(b => b.chords.length)) {
    const sig = b.type + ':' + b.chords.map(c => c.name).join(' ');
    const prev = out[out.length - 1];
    if (prev && prev.sig === sig) { prev.n++; continue; }
    out.push({ ...b, sig, n: 1 });
  }
  // počítání slok/refrénů jako v appce: Sloka 1, Sloka 2…
  const total = {}, seen = {};
  out.forEach(b => { total[b.type] = (total[b.type] || 0) + 1; });
  out.forEach(b => {
    seen[b.type] = (seen[b.type] || 0) + 1;
    const base = b.type ? SEC[b.type] || b.type : 'Začátek';
    b.label = (b.type === 'verse' && total[b.type] > 1) ? `${base} ${seen[b.type]}` : base;
  });
  return out;
}

const chip = (c, key) => {
  const d = degreeOf(c.root, key);
  return `<span class="ch ${d < 0 ? 'dx' : 'd' + d}">${esc(c.name)}</span>`;
};

const CSS = `
:root{--bg:#FFFBF4;--surface:#fff;--ink:#1D1A2F;--muted:#6E6A80;--line:#ECE5D8;
--d0:#FF5A5F;--d1:#FFB020;--d2:#7BC74D;--d3:#2D9CDB;--d4:#8B5CF6;--d5:#FF6FB5;--d6:#14B8A6}
@media (prefers-color-scheme:dark){:root{--bg:#14121D;--surface:#1D1A2A;--ink:#F4F1FA;--muted:#A39FB5;--line:#322D47}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Outfit,system-ui,sans-serif;line-height:1.5}
a{color:inherit}
.top{display:flex;align-items:center;gap:12px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--surface)}
.logo{font-weight:900;font-size:20px;text-decoration:none;letter-spacing:-.02em}.logo b{color:var(--d5)}
.top nav{margin-left:auto;font-size:15px}.top nav a{text-decoration:none;color:var(--muted);margin-left:14px}
.wrap{max-width:820px;margin:0 auto;padding:28px 16px 60px}
.crumbs{font-size:14px;color:var(--muted)}.crumbs a{color:var(--muted)}
h1{font-size:clamp(28px,6vw,42px);line-height:1.1;margin:10px 0 4px;letter-spacing:-.02em}
.artist{font-size:20px;color:var(--muted);margin:0 0 18px}.artist a{text-decoration:none}
.facts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 22px;padding:0;list-style:none}
.facts li{background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:5px 14px;font-size:15px}
.facts b{font-weight:800}
.cta{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 30px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:11px 20px;border-radius:14px;font-weight:800;text-decoration:none;font-size:16px;border:1px solid var(--line);background:var(--surface)}
.btn.main{background:linear-gradient(135deg,var(--d0),var(--d5) 50%,var(--d4));color:#fff;border:0}
.btn.gold{background:linear-gradient(135deg,#FFD54A,#F5A300);color:#3A2600;border:0}
h2{font-size:20px;margin:30px 0 12px}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.ch{display:inline-block;min-width:44px;text-align:center;padding:6px 12px;border-radius:12px;font-weight:800;font-size:17px;color:#fff;background:var(--d3)}
.ch.d0{background:var(--d0)}.ch.d1{background:var(--d1);color:#2A1E00}.ch.d2{background:var(--d2);color:#102A00}.ch.d3{background:var(--d3)}
.ch.d4{background:var(--d4)}.ch.d5{background:var(--d5)}.ch.d6{background:var(--d6)}.ch.dx{background:var(--muted)}
.secs{list-style:none;padding:0;margin:0;display:grid;gap:10px}
.secs li{background:var(--surface);border:1px solid var(--line);border-left:5px solid var(--sc,var(--muted));border-radius:14px;padding:10px 14px}
.secs .lab{font-weight:800;margin-bottom:6px}.secs .lab small{color:var(--muted);font-weight:600}
.secs .ch{font-size:15px;min-width:38px;padding:4px 10px}
.s-intro{--sc:#FFB020}.s-verse{--sc:#2D9CDB}.s-pre{--sc:#8B5CF6}.s-chorus{--sc:#FF5A5F}.s-bridge{--sc:#7BC74D}.s-solo{--sc:#FF8A3D}.s-inter{--sc:#B07CFF}.s-outro{--sc:#14B8A6}
.note{color:var(--muted);font-size:15px}
.list{list-style:none;padding:0;margin:0;columns:2 260px;column-gap:24px}
.list li{break-inside:avoid;padding:6px 0;border-bottom:1px solid var(--line)}
.list a{text-decoration:none;font-weight:700}.list span{color:var(--muted)}
footer{max-width:820px;margin:0 auto;padding:0 16px 40px;color:var(--muted);font-size:14px}
`;

function page({ title, desc, canonical, body, jsonld }) {
  return `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="${canonical}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="playalong.cz">
  <meta property="og:locale" content="cs_CZ">
  <meta property="og:url" content="${canonical}">
  <meta property="og:title" content="${esc(title)}">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:image" content="${SITE}/og-image.png">
  <meta name="twitter:card" content="summary_large_image">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800;900&display=swap" rel="stylesheet">
  <style>${CSS.trim()}</style>
${jsonld ? `  <script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>\n` : ''}</head>
<body>
  <header class="top"><a class="logo" href="/">playalong<b>.cz</b></a><nav><a href="/pisen/">Všechny písničky</a><a href="/">Zpěvník</a></nav></header>
${body}
  <footer>playalong.cz – společný zpěvník s akordy a play-along. Texty písní jsou jen v aplikaci.</footer>
</body>
</html>
`;
}

function songPage(s, slug, sameArtist) {
  const key = s.key || { root: 0, minor: false };
  const secs = sections(s);
  const uniq = [];
  secs.forEach(b => b.chords.forEach(c => { if (!uniq.some(u => u.name === c.name)) uniq.push(c); }));
  const hasSync = !!s.dur;
  const kp = `${keyName(key)} / ${keyName(relKey(key))}`;
  const name = `${s.artist ? s.artist + ' – ' : ''}${s.title}`;
  const title = `${name}: akordy a play-along | playalong.cz`;
  const chordList = uniq.map(c => c.name).join(', ');
  const desc = `${s.title}${s.artist ? ' (' + s.artist + ')' : ''} – akordy na kytaru v tónině ${keyName(key)}${s.capo ? ', kapodastr ' + s.capo + '. pražec' : ''}: ${chordList}.`
    + (hasSync ? ' Hraj s nahrávkou: text se přebarvuje podle zpěvu a akordy svítí včas.' : ' Transpozice a kapodastr jedním klikem.');
  const url = `${SITE}/pisen/${slug}/`;
  const artistSlug = s.artist ? slugify(s.artist) : '';
  const body = `  <main class="wrap">
    <div class="crumbs"><a href="/pisen/">Písničky</a>${s.artist ? ` › <a href="/pisen/#${artistSlug}">${esc(s.artist)}</a>` : ''}</div>
    <h1>${esc(s.title)}</h1>
    ${s.artist ? `<p class="artist">${esc(s.artist)}</p>` : ''}
    <ul class="facts">
      <li>Tónina <b>${esc(kp)}</b></li>
      <li>${s.capo ? `Kapodastr <b>${s.capo}. pražec</b>` : 'Bez kapodastru'}</li>
      <li>Akordů <b>${uniq.length}</b></li>
      ${hasSync ? `<li>Délka <b>${Math.floor(s.dur / 60)}:${String(Math.round(s.dur % 60)).padStart(2, '0')}</b></li>` : ''}
    </ul>
    <div class="cta">
      ${hasSync ? `<a class="btn main" href="/#along-${s.id}">▶ Play Along</a>` : ''}
      <a class="btn" href="/#play-${s.id}">🎸 Akordy s textem</a>
      ${hasSync && s.yt ? `<a class="btn gold" href="/#lyrics-${s.id}">♪ Moving Lyrics</a>` : ''}
    </div>
    <h2>Akordy v písničce</h2>
    <div class="chips">${uniq.map(c => chip(c, key)).join('')}</div>
    <p class="note">Barva akordu = jeho stupeň v tónině ${esc(keyName(key))}. V aplikaci jde písnička transponovat nebo zahrát s kapodastrem.</p>
    ${secs.length ? `<h2>Postup akordů</h2>
    <ol class="secs">
${secs.map(b => `      <li class="s-${b.type || 'none'}"><div class="lab">${esc(b.label)}${b.n > 1 ? ` <small>${b.n}×</small>` : ''}</div><div class="chips">${b.chords.map(c => chip(c, key)).join('')}</div></li>`).join('\n')}
    </ol>` : ''}
    ${sameArtist.length ? `<h2>Další od ${esc(s.artist)}</h2>
    <ul class="list">${sameArtist.map(o => `<li><a href="/pisen/${o.slug}/">${esc(o.title)}</a></li>`).join('')}</ul>` : ''}
  </main>`;
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'MusicComposition', name: s.title, url, inLanguage: 'cs',
      musicalKey: keyName(key), ...(s.artist ? { recordedAs: { '@type': 'MusicRecording', name: s.title, byArtist: { '@type': 'MusicGroup', name: s.artist } } } : {}) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Písničky', item: `${SITE}/pisen/` },
      { '@type': 'ListItem', position: 2, name, item: url }] },
  ];
  return page({ title, desc, canonical: url, body, jsonld });
}

function indexPage(list) {
  const byArtist = new Map();
  for (const s of list) {
    const a = s.artist || 'Ostatní';
    if (!byArtist.has(a)) byArtist.set(a, []);
    byArtist.get(a).push(s);
  }
  const artists = [...byArtist.keys()].sort((a, b) => a.localeCompare(b, 'cs'));
  const body = `  <main class="wrap">
    <h1>Písničky s akordy</h1>
    <p class="note">${list.length} ${list.length === 1 ? 'písnička' : list.length < 5 ? 'písničky' : 'písniček'} se akordy na kytaru – a většina i s play-alongem: hraješ s nahrávkou, text se přebarvuje podle zpěvu a akordy svítí přesně včas.</p>
${artists.map(a => `    <h2 id="${slugify(a)}">${esc(a)}</h2>
    <ul class="list">${byArtist.get(a).sort((x, y) => x.title.localeCompare(y.title, 'cs')).map(s => `<li><a href="/pisen/${s.slug}/">${esc(s.title)}</a> <span>· ${esc(keyName(s.key || { root: 0 }))}</span></li>`).join('')}</ul>`).join('\n')}
  </main>`;
  return page({
    title: 'Písničky s akordy a play-along | playalong.cz',
    desc: `Seznam písniček s akordy na kytaru (${artists.slice(0, 6).join(', ')}…). Play-along s nahrávkou, transpozice a kapodastr.`,
    canonical: `${SITE}/pisen/`, body,
    jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Písničky s akordy', url: `${SITE}/pisen/`, inLanguage: 'cs' },
  });
}

// ---------- hlavní běh ----------
const songs = (await fetchSongs()).filter(s => s.title && Array.isArray(s.lines));
const slugFile = path.join(OUT, '_slugs.json');
let slugs = {};
try { slugs = JSON.parse(fs.readFileSync(slugFile, 'utf8')); } catch { /* první běh */ }
const used = new Set();
for (const s of songs) {   // slug zůstává stejný i po přejmenování (odkazy z Googlu nepřestanou fungovat)
  let slug = slugs[s.id];
  if (!slug || used.has(slug)) {
    const base = slugify((s.artist ? s.artist + '-' : '') + s.title);
    slug = base; let i = 2;
    while (used.has(slug) || Object.entries(slugs).some(([id, v]) => v === slug && id !== s.id)) slug = `${base}-${i++}`;
  }
  slugs[s.id] = slug; s.slug = slug; used.add(slug);
}

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old !== text) fs.writeFileSync(file, text);
};
for (const s of songs) {
  const same = songs.filter(o => o !== s && o.artist && o.artist === s.artist);
  write(path.join(OUT, s.slug, 'index.html'), songPage(s, s.slug, same));
}
write(path.join(OUT, 'index.html'), indexPage(songs));

// stránky smazaných / skrytých písniček pryč
for (const d of fs.readdirSync(OUT, { withFileTypes: true })) {
  if (d.isDirectory() && !used.has(d.name)) fs.rmSync(path.join(OUT, d.name), { recursive: true });
}
const keep = Object.fromEntries(Object.entries(slugs).filter(([id]) => songs.some(s => s.id === id)));
write(slugFile, JSON.stringify(keep, null, 1) + '\n');

const newest = songs.reduce((m, s) => (s.updated_at > m ? s.updated_at : m), '2026-11-28');
const urls = [
  { loc: `${SITE}/`, lastmod: day(newest), freq: 'weekly', pri: '1.0' },
  { loc: `${SITE}/pisen/`, lastmod: day(newest), freq: 'weekly', pri: '0.8' },
  ...songs.map(s => ({ loc: `${SITE}/pisen/${s.slug}/`, lastmod: day(s.updated_at), freq: 'monthly', pri: '0.7' })),
];
write(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`).join('\n')}
</urlset>
`);
console.log(`Hotovo: ${songs.length} stránek písniček, sitemap ${urls.length} adres.`);
