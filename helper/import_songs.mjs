// playalong.cz – hromadný import písniček ze složky (bez ručního přepisování textů).
//
// Složka (výchozí C:\PlayAlong\Songs) obsahuje soubory „Interpret - Název.txt“:
//   1. řádek: YouTube odkaz
//   zbytek:   text s akordy (nad řádky nebo [Am]) a značkami částí ([Sloka], R: …) – stejně jako „+ Přidat song“
//
// Použití (z kořene projektu):
//   node helper/import_songs.mjs                 → jen kontrola (nic neukládá), vypíše tabulku a varování
//   node helper/import_songs.mjs --import        → přidá do zpěvníku (čeká na schválení – vidí jen admin) a zařadí do fronty
//   node helper/import_songs.mjs --import --private  → totéž, ale soukromě 🔒 (i po schválení jen pro admina)
//   node helper/import_songs.mjs --report        → výsledky fronty: kolik slov sedí s nahrávkou, které řádky nesedí
//   volitelně --dir "C:\jina\slozka", --no-queue (jen přidat, Play Along nespouštět), --no-video (bez kontroly videí)
//
// Texty se nikam nevypisují – skript hlásí jen čísla (řádky, akordy, % shody).
// Potřebuje helper/secrets.json (supabase_secret) a yt-dlp (kontrola videí).
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const DIR = opt('--dir', 'C:\\PlayAlong\\Songs');
const STATE = path.join(DIR, '_import.json');   // soubor → id písničky (aby se nic nepřidalo dvakrát)

// ---------- parser z app.js (stejný jako ve webu) ----------
function loadParser() {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const a = src.indexOf('const NAMES = {');
  const b = src.indexOf('function songToText(');
  if (a < 0 || b < 0) throw new Error('V app.js jsem nenašel parser (NAMES … songToText).');
  const ctx = { settings: { notation: 'intl' }, mod: n => ((n % 12) + 12) % 12, console };
  vm.createContext(ctx);
  vm.runInContext(src.slice(a, b) + '\nthis.parseLyrics = parseLyrics; this.guessKeyScored = guessKeyScored; this.keyName = keyName; this.degreeOf = degreeOf;', ctx);
  return ctx;
}

// ---------- Supabase (service role, jen lokálně) ----------
function supa() {
  const secrets = JSON.parse(fs.readFileSync(path.join(HERE, 'secrets.json'), 'utf8'));
  const url = /https:\/\/[a-z0-9]+\.supabase\.co/.exec(fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8'))[0];
  const key = secrets.supabase_secret;
  return async (method, p, body, prefer) => {
    const r = await fetch(`${url}/rest/v1/${p}`, {
      method,
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 300)}`);
    return t ? JSON.parse(t) : null;
  };
}

// ---------- pomocné ----------
const YT = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/;
const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const uid = () => Array.from({ length: 12 }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 36)]).join('');
const pad = (s, n) => String(s).padEnd(n).slice(0, n);

function videoInfo(id) {
  try {
    const out = execFileSync('python', ['-m', 'yt_dlp', '-j', '--skip-download', '--no-warnings', '--js-runtimes', 'node',
      'https://www.youtube.com/watch?v=' + id], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 });
    const j = JSON.parse(out);
    return { ok: true, title: j.title || '', channel: j.channel || j.uploader || '', duration: j.duration || 0, embed: j.playable_in_embed !== false };
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    return { ok: false, error: /Private|unavailable|removed/i.test(msg) ? 'video nedostupné' : msg.split('\n').filter(Boolean).pop()?.slice(0, 120) };
  }
}

function readSongs(P) {
  if (!fs.existsSync(DIR)) { console.log(`Složka ${DIR} neexistuje.`); return []; }
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith('.txt')).sort();
  return files.map(file => {
    const raw = fs.readFileSync(path.join(DIR, file), 'utf8').replace(/^\uFEFF/, '');
    const lines = raw.replace(/\r/g, '').split('\n');
    const first = lines.findIndex(l => l.trim());
    const ytLine = first >= 0 ? lines[first].trim() : '';
    const yt = YT.exec(ytLine)?.[1] || (/^[\w-]{11}$/.test(ytLine) ? ytLine : null);
    const body = yt ? lines.slice(first + 1).join('\n') : lines.join('\n');
    const base = file.replace(/\.txt$/i, '');
    const dash = base.indexOf(' - ');
    const artist = dash > 0 ? base.slice(0, dash).trim() : '';
    const title = dash > 0 ? base.slice(dash + 3).trim() : base.trim();
    const parsed = P.parseLyrics(body);
    const g = P.guessKeyScored(parsed);
    const key = g?.key || { root: 7, minor: false };
    const chords = parsed.flatMap(l => l.chords);
    const textLines = parsed.filter(l => l.text.trim());
    const words = textLines.reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
    const outside = chords.filter(c => P.degreeOf(c.root, key) < 0).length;
    const warn = [];
    if (!yt) warn.push('chybí YouTube odkaz na 1. řádku');
    if (!textLines.length) warn.push('žádný text');
    if (!chords.length) warn.push('žádné akordy');
    else if (outside / chords.length > 0.25) warn.push(`${Math.round(outside / chords.length * 100)} % akordů mimo tóninu – zkontroluj B/H nebo akordy`);
    if (!artist) warn.push('název souboru není „Interpret - Název“');
    return { file, title, artist, yt, lines: parsed, key, keyName: P.keyName(key), nLines: textLines.length, nWords: words, nChords: chords.length,
      sections: parsed.filter(l => l.section).length, warn };
  });
}

function checkVideos(songs) {
  for (const s of songs) {
    if (!s.yt) continue;
    process.stdout.write(`   video ${s.yt} (${s.title})… `);
    const v = videoInfo(s.yt);
    s.video = v;
    if (!v.ok) { s.warn.push('YouTube: ' + v.error); console.log('✗'); continue; }
    console.log(`${Math.floor(v.duration / 60)}:${String(v.duration % 60).padStart(2, '0')}`);
    const vt = norm(v.title + ' ' + v.channel);
    const titleWords = norm(s.title).split(' ').filter(w => w.length > 2);
    const hit = titleWords.filter(w => vt.includes(w)).length;
    if (titleWords.length && hit / titleWords.length < 0.5) s.warn.push(`název videa nesedí („${v.title.slice(0, 60)}“)`);
    if (/live|koncert|concert|cover|karaoke|instrumental|remix|nightcore|8d audio/i.test(v.title)) s.warn.push('video vypadá jako živák/cover/karaoke');
    if (!v.embed) s.warn.push('video nejde vložit do webu (YouTube embed zakázán)');
    if (v.duration > 15 * 60) s.warn.push('video je delší než 15 minut');
    if (v.duration && s.nWords && s.nWords / v.duration < 0.15) s.warn.push('na délku videa je text nějak krátký');
  }
}

function printTable(songs) {
  console.log('\n' + pad('soubor', 42) + pad('tónina', 8) + pad('řádků', 7) + pad('slov', 6) + pad('akordů', 8) + 'částí');
  for (const s of songs) console.log(pad(s.file, 42) + pad(s.keyName, 8) + pad(s.nLines, 7) + pad(s.nWords, 6) + pad(s.nChords, 8) + s.sections);
  const bad = songs.filter(s => s.warn.length);
  console.log(`\n${songs.length} souborů, ${songs.length - bad.length} bez připomínek.`);
  for (const s of bad) console.log(`⚠ ${s.file}\n   - ${s.warn.join('\n   - ')}`);
}

async function doImport(songs, rest) {
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const admin = (await rest('GET', 'admins?select=user_id&limit=1'))[0]?.user_id;
  if (!admin) throw new Error('V tabulce admins nikdo není.');
  const isPublic = !flag('--private');   // výchozí: veřejná, ale čeká na schválení (vidí ji jen admin)
  for (const s of songs) {
    if (state[s.file]) { console.log(`= ${s.file}: už importováno (${state[s.file]})`); continue; }
    const blocking = s.warn.filter(w => /chybí YouTube|žádný text|nedostupné|nejde vložit/.test(w));
    if (blocking.length) { console.log(`✗ ${s.file}: přeskočeno (${blocking.join(', ')})`); continue; }
    const id = uid();
    await rest('POST', 'songs', {
      id, owner: admin, author_name: 'Bob', title: s.title.slice(0, 200), artist: s.artist.slice(0, 200), is_public: isPublic,
      data: { key: s.key, baseKey: null, capo: 0, lines: s.lines, custom: [], sync: null },
    });
    if (!flag('--no-queue')) await rest('POST', 'jobs', { song_id: id, yt: s.yt, created_by: admin });
    state[s.file] = id;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    console.log(`✓ ${s.file} → ${id} (${isPublic ? 'čeká na schválení' : 'soukromá 🔒'})${flag('--no-queue') ? '' : ', ve frontě'}`);
  }
}

async function report(rest) {
  const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {};
  const ids = Object.values(state);
  if (!ids.length) { console.log('Zatím nic importováno.'); return; }
  const jobs = await rest('GET', `jobs?song_id=in.(${ids.join(',')})&select=song_id,status,error,stats,created_at&order=created_at.desc`);
  const latest = new Map();
  for (const j of jobs) if (!latest.has(j.song_id)) latest.set(j.song_id, j);
  console.log(pad('soubor', 42) + pad('stav', 9) + pad('slova', 12) + pad('shoda', 7) + pad('BPM', 6) + 'nesedící řádky');
  for (const [file, id] of Object.entries(state)) {
    const j = latest.get(id);
    if (!j) { console.log(pad(file, 42) + 'bez úlohy'); continue; }
    const st = j.stats || {};
    const pct = st.ours ? Math.round(100 * st.matched / st.ours) : null;
    const flagTxt = pct == null ? '' : pct >= 85 ? '✓' : pct >= 70 ? '~' : '✗';
    console.log(pad(file, 42) + pad(j.status, 9) + pad(st.ours ? `${st.matched}/${st.ours}` : '', 12) + pad(pct == null ? '' : pct + ' % ' + flagTxt, 7)
      + pad(st.bpm || '', 6) + (j.error ? 'CHYBA: ' + j.error.slice(0, 80) : (st.badLines || []).map(n => n + 1).join(', ')));
  }
  console.log('\nShoda = kolik slov z textu se našlo v nahrávce. Pod ~85 % bývá jiná verze textu (sloky, opakování) nebo jiné video.');
}

// ---------- hlavní ----------
async function main() {
  const P = loadParser();
  if (flag('--report')) return report(supa());
  const songs = readSongs(P);
  if (!songs.length) { console.log(`Ve složce ${DIR} nejsou žádné .txt soubory.`); return; }
  console.log(`Kontroluju ${songs.length} písniček ve ${DIR}…`);
  if (!flag('--no-video')) checkVideos(songs);
  printTable(songs);
  if (flag('--import')) { console.log(''); await doImport(songs, supa()); }
  else console.log('\n(Jen kontrola. Pro uložení spusť s --import.)');
}
main().catch(e => { console.error('✗', e.message || e); process.exitCode = 1; });
