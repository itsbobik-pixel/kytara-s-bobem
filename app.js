'use strict';
/* =========================================================
   Kytara s Bobem – zpěvník s drag & drop akordy
   ========================================================= */

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const mod = n => ((n % 12) + 12) % 12;
const clone = o => JSON.parse(JSON.stringify(o));

// ---------- storage ----------
const LS_SONGS = 'ksb.songs.v1';
const LS_SETTINGS = 'ksb.settings.v1';
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function persist(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage nedostupné */ }
}
let songs = load(LS_SONGS, []);
const settings = Object.assign({ notation: 'intl', fontSize: 19 }, load(LS_SETTINGS, {}));
// v2: výchozí značení je mezinárodní (A#, B) – jednorázově přepni i dřív uložené nastavení
if (settings.nv !== 2) { settings.notation = 'intl'; settings.nv = 2; persist(LS_SETTINGS, settings); }
const saveSettings = () => persist(LS_SETTINGS, settings);
function saveSongs() {
  if (auth.mode === 'supabase') { window.KSB_SUPA.schedule(); return; }
  persist(LS_SONGS, songs);
  cloud.schedule();
}

// ---------- kdo je přihlášený a co smí ----------
// mode 'local' = vše v prohlížeči (nebo claude.ai cloud), 'supabase' = společný zpěvník
const auth = { mode: 'local', user: null, admin: false, name: '', loading: false, localOnly: [] };
const canEdit = s => auth.mode !== 'supabase' || (!!auth.user && (!s.owner || s.owner === auth.user.id || auth.admin));
const canCreate = () => auth.mode !== 'supabase' || !!auth.user;
const isPlay = s => route.mode === 'play' || !canEdit(s);
function needLogin(reason) {
  if (canCreate()) return false;
  window.KSB_SUPA.openLogin(reason);
  return true;
}

// ---------- cloud (jen když běží jako claude.ai Artifact) ----------
// Každý přihlášený má vlastní soukromý zpěvník: data/users/<id>/<songId>
const cloud = {
  col: null,
  synced: new Map(),     // id → JSON naposledy uložený / přijatý z cloudu
  timer: 0,
  flushing: false,
  again: false,
  ready: false,

  async init() {
    if (!window.claude?.use) return;
    try {
      const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
      const uid = db && user ? await user.id() : null;
      if (!uid) return;
      this.col = db.collection('data/users/' + uid);
    } catch { return; }
    setStatus('☁ Načítám…');
    const loading = setTimeout(() => setStatus('☁ Cloud teď nejde načíst'), 10000);
    this.col.onSnapshot(snap => {
      if (snap.metadata.fromCache) return;
      clearTimeout(loading);
      const remote = snap.docs.map(d => clone(d.data()));
      if (!this.ready) {
        this.ready = true;
        // první načtení: spoj cloud s tím, co je v prohlížeči
        remote.forEach(r => this.synced.set(r.id, JSON.stringify(r)));
        const byId = new Map(remote.map(r => [r.id, r]));
        for (const s of songs) {
          const r = byId.get(s.id);
          if (!r || (s.updated || 0) > (r.updated || 0)) byId.set(s.id, s);
        }
        songs = [...byId.values()];
        persist(LS_SONGS, songs);
        this.schedule(0);
        setStatus('☁ Uloženo v cloudu');
        render();
        return;
      }
      // další změny (třeba z mobilu) – převezmi jen to, co se opravdu liší
      let changed = false;
      const ids = new Set();
      for (const r of remote) {
        ids.add(r.id);
        const json = JSON.stringify(r);
        if (this.synced.get(r.id) === json) continue;
        this.synced.set(r.id, json);
        const i = songs.findIndex(s => s.id === r.id);
        if (i < 0) songs.push(r);
        else if ((r.updated || 0) >= (songs[i].updated || 0)) songs[i] = r;
        else continue;
        changed = true;
      }
      for (const id of [...this.synced.keys()]) {
        if (!ids.has(id)) {
          this.synced.delete(id);
          if (songs.some(s => s.id === id)) { songs = songs.filter(s => s.id !== id); changed = true; }
        }
      }
      if (changed) {
        persist(LS_SONGS, songs);
        const typing = document.activeElement?.matches?.('input, textarea');
        if (!drag && !typing) render();
      }
    }, () => { clearTimeout(loading); setStatus('☁ Cloud nedostupný – ukládám jen v prohlížeči'); });
  },

  schedule(delay = 700) {
    if (!this.col || !this.ready) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  },

  async flush() {
    if (this.flushing) { this.again = true; return; }
    this.flushing = true;
    setStatus('☁ Ukládám…');
    let failed = false;
    try {
      const ids = new Set();
      for (const s of songs) {
        ids.add(s.id);
        const json = JSON.stringify(s);
        if (this.synced.get(s.id) === json) continue;
        try { await this.col.doc(s.id).set(JSON.parse(json)); this.synced.set(s.id, json); }
        catch (e) { failed = true; if (e?.code === 'quota_exceeded') toast('Cloud je plný – smaž pár songů'); }
      }
      for (const id of [...this.synced.keys()]) {
        if (ids.has(id)) continue;
        try { await this.col.doc(id).delete(); this.synced.delete(id); } catch { failed = true; }
      }
    } finally {
      this.flushing = false;
      setStatus(failed ? '☁ Něco se neuložilo, zkusím znovu' : '☁ Uloženo v cloudu');
      if (failed) this.schedule(5000);
      if (this.again) { this.again = false; this.schedule(0); }
    }
  },
};
let statusText = '';
function setStatus(t) {
  statusText = t;
  const el = $('#syncStatus');
  if (el) el.textContent = t;
}

// =========================================================
//  HUDEBNÍ TEORIE
// =========================================================
const NAMES = {
  cz:   { sharp: ['C','C#','D','D#','E','F','F#','G','G#','A','B','H'], flat: ['C','Db','D','Eb','E','F','Gb','G','Ab','A','B','H'] },
  intl: { sharp: ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'], flat: ['C','Db','D','Eb','E','F','Gb','G','Ab','A','Bb','B'] },
};
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];

// Názvy tónů vždy s křížky (C# D# F# G#), žádné Es/As/Db. V českém značení zůstává B (= A#) a H.
function useFlats() { return false; }
function noteName(root, key) {
  const n = NAMES[settings.notation] || NAMES.cz;
  return (useFlats(key) ? n.flat : n.sharp)[mod(root)];
}
function chordName(c, key) {
  return noteName(c.root, key) + (c.q || '') + (c.bass != null ? '/' + noteName(c.bass, key) : '');
}
function keyName(key) { return noteName(key.root, key) + (key.minor ? ' moll' : ' dur'); }
function keyShort(key) { return noteName(key.root, key) + (key.minor ? 'm' : ''); }
/** paralelní tónina: G dur ↔ E moll */
const relKey = key => key.minor ? { root: mod(key.root + 3), minor: false } : { root: mod(key.root - 3), minor: true };
const keyBoth = key => `${keyName(key)} / ${keyShort(relKey(key))}`;   // „G dur / Em“
const keyPair = key => `${keyShort(key)} / ${keyShort(relKey(key))}`;  // „G / Em“

/** stupeň (0–6) akordu v tónině, nebo -1 když je mimo stupnici */
function degreeOf(root, key) {
  return (key.minor ? MINOR : MAJOR).indexOf(mod(root - key.root));
}
const degClass = (root, key) => { const d = degreeOf(root, key); return d < 0 ? 'dx' : 'd' + d; };

function triadType(q = '') {
  if (q.startsWith('dim') || q.startsWith('°')) return 'dim';
  if (q.startsWith('m') && !q.startsWith('maj')) return 'min';
  return 'maj';
}

function paletteFor(key) {
  const r = key.root;
  const mk = list => list.map(([o, q, roman]) => ({ root: mod(r + o), q, roman }));
  if (!key.minor) {
    return {
      main: mk([[0,'','I'],[2,'m','ii'],[4,'m','iii'],[5,'','IV'],[7,'','V'],[9,'m','vi'],[11,'dim','vii°']]),
      extra: mk([[7,'7','V7'],[2,'m7','ii7'],[5,'maj7','IVmaj7'],[0,'sus4','Isus4'],[7,'sus4','Vsus4'],[2,'','II'],[4,'','III'],[10,'','♭VII'],[5,'m','iv']]),
    };
  }
  return {
    main: mk([[0,'m','i'],[2,'dim','ii°'],[3,'','III'],[5,'m','iv'],[7,'m','v'],[8,'','VI'],[10,'','VII']]),
    extra: mk([[7,'','V'],[7,'7','V7'],[5,'','IV'],[0,'m7','i7'],[5,'m7','iv7'],[8,'maj7','VImaj7'],[3,'maj7','IIImaj7'],[0,'sus4','isus4']]),
  };
}

// tóniny, které jsou na kytaru pohodlné
const RECOMMENDED = { major: [7, 2, 0, 9, 4], minor: [4, 9, 2, 11] };
const isRecommended = key => (key.minor ? RECOMMENDED.minor : RECOMMENDED.major).includes(key.root);

// ---------- parsování akordů ----------
function parseNote(s) {
  const m = /^([A-H])(#|♯|b|♭|is|es|s(?!us))?/.exec(s);
  if (!m) return null;
  const czB = czParse ?? settings.notation === 'cz';   // v českém zápisu je B = A#
  const L = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11, B: czB ? 10 : 11 };
  let semi = L[m[1]];
  const acc = m[2];
  if (acc === '#' || acc === '♯' || acc === 'is') semi += 1;
  else if (acc) semi -= 1;
  return { semi: mod(semi), len: m[0].length };
}
const SUFFIX_OK = /^(maj|min|m|M|dim|aug|sus|add|[0-9]|\+|-|°|ø|\(|\)|b|#)*$/;
function parseChord(tok) {
  tok = tok.trim();
  if (!tok) return null;
  const n = parseNote(tok);
  if (!n) return null;
  let rest = tok.slice(n.len);
  let bass = null;
  const sl = rest.lastIndexOf('/');
  if (sl >= 0) {
    const b = parseNote(rest.slice(sl + 1));
    if (!b || b.len !== rest.length - sl - 1) return null;
    bass = b.semi;
    rest = rest.slice(0, sl);
  }
  let q = rest;
  const mm = /^(moll|min|mi)/.exec(q);
  if (mm) q = 'm' + q.slice(mm[0].length);
  q = q.replace(/^(Maj|MAJ|M)(?=7|9|$)/, 'maj').replace(/^\+$/, 'aug').replace(/^°$/, 'dim');
  if (q.length > 8 || !SUFFIX_OK.test(q)) return null;
  return { root: n.semi, q, bass };
}

const IGNORE_TOK = /^(\|+|-+|\/+|x\d+|\(?x?\d+x?\)?|N\.?C\.?|%|\.+|:\|?|\|:)$/i;
function chordLine(line) {
  if (!line.trim()) return null;
  const chords = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line))) {
    const raw = m[0];
    if (IGNORE_TOK.test(raw)) continue;
    const stripped = raw.replace(/^[(\[]+/, '');
    const off = raw.length - stripped.length;
    const c = parseChord(stripped.replace(/[)\],]+$/, ''));
    if (!c) return null;
    chords.push({ pos: m.index + off, ...c });
  }
  return chords.length ? chords : null;
}
function extractInline(line) {
  let text = '';
  const chords = [];
  const re = /\[([^\]]+)\]/g;
  let m, last = 0;
  while ((m = re.exec(line))) {
    text += line.slice(last, m.index);
    const c = parseChord(m[1]);
    if (c) chords.push({ pos: text.length, ...c });
    else text += m[0];
    last = re.lastIndex;
  }
  text += line.slice(last);
  return { text, chords };
}

// ---------- části písně ----------
const SECTIONS = [
  { type: 'intro',  label: 'Intro' },
  { type: 'verse',  label: 'Sloka' },
  { type: 'pre',    label: 'Předrefrén' },
  { type: 'chorus', label: 'Refrén' },
  { type: 'bridge', label: 'Bridge' },
  { type: 'solo',   label: 'Sólo' },
  { type: 'outro',  label: 'Outro' },
];
const secLabel = t => (SECTIONS.find(s => s.type === t) || { label: t }).label;
const SEC_WORDS = [
  [/^(intro|úvod|uvod|předehra|predehra)$/i, 'intro'],
  [/^(sloka|verse|verš|vers|s|v)$/i, 'verse'],
  [/^(předrefrén|predrefren|prerefrén|prerefren|pre-?chorus|pre)$/i, 'pre'],
  [/^(refrén|refren|ref|r|chorus)$/i, 'chorus'],
  [/^(bridge|most|mezihra)$/i, 'bridge'],
  [/^(sólo|solo)$/i, 'solo'],
  [/^(outro|dohra|závěr|zaver|coda|konec)$/i, 'outro'],
];
const secType = w => { for (const [re, t] of SEC_WORDS) if (re.test(w)) return t; return null; };

function detectSection(line) {
  const t = line.trim();
  if (!t) return null;
  const done = (type, rest) => {
    rest = rest.replace(/^[:.\s]+/, '');
    return { type, rest, offset: line.length - rest.length };
  };
  let m = /^\[\s*([^\]\d:]+?)\s*\d*\s*[:.]?\s*\]\s*(.*)$/.exec(t);          // [Refrén 2] …
  if (m) { const ty = secType(m[1]); if (ty) return done(ty, m[2]); }
  m = /^([A-Za-zÀ-žěščřžýáíéúůňťď-]+)\.?\s*\d*\s*[:.]\s*(.*)$/.exec(t);      // R: …  Sloka 1: …
  if (m) { const ty = secType(m[1]); if (ty) return done(ty, m[2]); }
  m = /^([A-Za-zÀ-žěščřžýáíéúůňťď-]{2,})\s*\d*$/.exec(t);                  // Refrén
  if (m) { const ty = secType(m[1]); if (ty) return done(ty, ''); }
  m = /^(\d+)\s*[.)]\s*(.*)$/.exec(t);                                       // 1. …
  if (m) return done('verse', m[2]);
  return null;
}

function normalizeChords(chords) {
  const out = [];
  chords.map(c => ({ ...c, pos: Math.max(0, c.pos | 0) }))
    .sort((a, b) => a.pos - b.pos)
    .forEach(c => {
      const prev = out[out.length - 1];
      if (prev && c.pos <= prev.pos) c.pos = prev.pos + 1;
      out.push(c);
    });
  return out;
}

// Když vložený text obsahuje akord H (český zápis), čteme v něm B jako A#.
let czParse = null;
const CZ_H_CHORD = /(^|[\s\[(|])H(is|#)?(m|mi|moll|7|maj7|sus2|sus4|dim|add9|6|9)?(\/[A-H][#b]?)?(?=[\s\])|,]|$)/m;
function parseLyrics(raw) {
  const parseAs = cz => { czParse = cz; try { return parseLyricsInner(raw); } finally { czParse = null; } };
  if (CZ_H_CHORD.test(raw)) return parseAs(true);
  // bez H nevíme, jestli B znamená B, nebo české B (= A#) → vyber čtení, které lépe sedí do tóniny
  const intl = parseAs(false);
  if (!intl.some(l => l.chords.some(c => c.root === 11 || c.bass === 11))) return intl;
  const cz = parseAs(true);
  return keyFit(cz) > keyFit(intl) ? cz : intl;
}
const keyFit = lines => guessKeyScored(lines)?.s ?? 0;
function parseLyricsInner(raw) {
  const src = raw.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
  const out = [];
  let pendingSection = null;
  let pendingChords = null;
  const push = (text, chords) => { out.push({ text, chords: normalizeChords(chords), section: pendingSection }); pendingSection = null; };
  const flush = () => { if (pendingChords) { push('', pendingChords); pendingChords = null; } };

  for (const rawLine of src) {
    let line = rawLine.replace(/\s+$/, '');
    let offset = 0;
    const sh = detectSection(line);
    if (sh) {
      flush();
      pendingSection = sh.type;
      offset = sh.offset;
      line = sh.rest;
      if (!line.trim()) continue;
    }
    const cl = chordLine(line);
    if (cl) { flush(); pendingChords = cl; continue; }

    let { text, chords } = extractInline(line);
    if (pendingChords) { chords = chords.concat(pendingChords.map(c => ({ ...c, pos: c.pos - offset }))); pendingChords = null; }
    if (!text.trim()) {
      if (chords.length) { push('', chords); continue; }
      out.push({ text: '', chords: [], section: null });
      continue;
    }
    const lead = text.match(/^\s*/)[0].length;
    text = text.slice(lead);
    chords = chords.map(c => ({ ...c, pos: c.pos - lead }));
    push(text, chords);
  }
  flush();
  if (pendingSection) out.push({ text: '', chords: [], section: pendingSection });

  // ořízni a slouč prázdné řádky
  const isBlank = l => !l.text && !l.chords.length && !l.section;
  const res = [];
  for (const l of out) {
    if (isBlank(l) && (!res.length || isBlank(res[res.length - 1]))) continue;
    res.push(l);
  }
  while (res.length && isBlank(res[res.length - 1])) res.pop();
  return res;
}

function guessKey(lines) { return guessKeyScored(lines)?.key || null; }
function guessKeyScored(lines) {
  const chords = lines.flatMap(l => l.chords);
  if (!chords.length) return null;
  let best = null;
  for (const minor of [false, true]) {
    for (let root = 0; root < 12; root++) {
      const key = { root, minor };
      const pal = paletteFor(key).main;
      let s = 0;
      for (const c of chords) {
        const t = triadType(c.q);
        if (pal.some(p => p.root === c.root && triadType(p.q) === t)) s += 1;
        else if (minor && mod(c.root - root) === 7 && t === 'maj') s += 0.6;
      }
      const tonic = c => c.root === root && triadType(c.q) === (minor ? 'min' : 'maj');
      if (tonic(chords[0])) s += 1.5;
      if (tonic(chords[chords.length - 1])) s += 1.5;
      if (!minor) s += 0.05;
      if (isRecommended(key)) s += 0.02;
      if (!best || s > best.s) best = { key, s };
    }
  }
  return best;
}

function songToText(song) {
  return song.lines.map(l => {
    let s = l.text.padEnd(l.chords.reduce((m, c) => Math.max(m, c.pos), 0), ' ');
    [...l.chords].sort((a, b) => b.pos - a.pos).forEach(c => {
      s = s.slice(0, c.pos) + '[' + chordName(c, song.key) + ']' + s.slice(c.pos);
    });
    s = s.replace(/\s+$/, '');
    return (l.section ? '[' + secLabel(l.section) + ']\n' : '') + s;
  }).join('\n');
}

// =========================================================
//  STAV + UNDO
// =========================================================
let route = { view: 'list' };
let armed = null;             // akord vybraný kliknutím (tap-to-place)
let undoStack = [];
let autoscroll = { on: false, speed: 2, raf: 0, last: 0, acc: 0 };

const current = () => songs.find(s => s.id === route.id);
function touch(song) { song.updated = Date.now(); saveSongs(); }
function pushUndo(song) {
  undoStack.push({ id: song.id, lines: clone(song.lines), key: clone(song.key), custom: clone(song.custom || []), capo: song.capo || 0 });
  if (undoStack.length > 60) undoStack.shift();
}
function undo() {
  const u = undoStack.pop();
  const song = u && songs.find(s => s.id === u.id);
  if (!song) return;
  song.lines = u.lines; song.key = u.key; song.custom = u.custom; song.capo = u.capo || 0;
  touch(song);
  renderEditor();
  toast('Vráceno zpět');
}

// =========================================================
//  ROUTER
// =========================================================
function parseHash() {
  const m = /^#(song|play)-([A-Za-z0-9]+)$/.exec(location.hash);
  if (m) return { view: 'song', id: m[2], mode: m[1] === 'play' ? 'play' : 'edit' };
  return { view: 'list' };
}
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', render);

function render() {
  closePopover();
  stopAutoscroll();
  armed = null;
  route = parseHash();
  if (route.view === 'song' && !current()) {
    if (auth.loading) { $('#app').innerHTML = '<div class="wrap"><div class="empty"><div class="big-emoji">🎸</div><h2>Načítám song…</h2></div></div>'; return; }
    go('#'); return;
  }
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  if (route.view === 'song') renderEditor(); else renderLibrary();
}

// =========================================================
//  TOPBAR
// =========================================================
function renderTopActions(extra = []) {
  const box = $('#topActions');
  box.innerHTML = '';
  box.append(
    h('span', { id: 'syncStatus', class: 'sync' }, statusText),
    ...extra.filter(Boolean),
    auth.mode === 'supabase' && (auth.user
      ? h('button', {
          class: 'btn ghost user-btn', title: 'Klikni pro odhlášení',
          onclick: () => window.KSB_SUPA.logout(),
        }, '👤 ', auth.name || 'Já', auth.admin ? h('small', {}, ' admin') : null)
      : h('button', { class: 'btn primary', onclick: () => window.KSB_SUPA.openLogin() }, 'Přihlásit')),
    h('button', {
      class: 'btn ghost', title: 'Přepnout značení (česky H / anglicky B)',
      onclick: () => { settings.notation = settings.notation === 'cz' ? 'intl' : 'cz'; saveSettings(); render(); },
    }, 'Značení: ', h('b', {}, settings.notation === 'cz' ? 'H' : 'B')),
  );
}

// =========================================================
//  KNIHOVNA
// =========================================================
const CARD_COLORS = ['--d0', '--d3', '--d4', '--d5', '--d6', '--d1', '--d2'];
let searchQ = '';

function renderLibrary() {
  const app = $('#app');
  app.innerHTML = '';
  const shared = auth.mode === 'supabase';
  renderTopActions([
    canCreate() && h('button', { class: 'btn ghost', onclick: exportSongs, title: 'Stáhnout zálohu songů' }, '⬇ Záloha'),
    canCreate() && h('button', { class: 'btn ghost', onclick: importSongs, title: 'Nahrát zálohu' }, '⬆ Nahrát'),
  ]);

  const addSong = () => { if (!needLogin('Pro přidání songu se přihlas. Číst může kdokoli.')) openSongModal(); };
  const wrap = h('div', { class: 'wrap' });
  wrap.append(h('section', { class: 'hero' },
    h('div', {},
      shared
        ? h('h1', {}, 'Společný ', h('span', { class: 'hl' }, 'zpěvník'))
        : h('h1', {}, 'Tvoje ', h('span', { class: 'hl' }, 'songy')),
      h('p', {}, shared
        ? 'Písničky s akordy pro všechny. Přihlaš se a přidej svoje.'
        : 'Vlož text, vyber tóninu a přetáhni akordy přímo nad slova.')),
    h('button', { class: 'btn rainbow big', onclick: addSong }, '+ Přidat song')));

  if (shared && auth.user && auth.localOnly.length) {
    wrap.append(h('div', { class: 'banner' },
      h('span', {}, `V tomhle prohlížeči máš ${auth.localOnly.length} songů, které ještě nejsou ve zpěvníku.`),
      h('button', { class: 'btn primary', onclick: () => window.KSB_SUPA.importLocal() }, 'Nahrát do zpěvníku')));
  }

  if (auth.loading) {
    wrap.append(h('div', { class: 'empty' }, h('div', { class: 'big-emoji' }, '🎸'), h('h2', {}, 'Načítám zpěvník…')));
    app.append(wrap);
    return;
  }

  if (!songs.length) {
    wrap.append(h('div', { class: 'empty' },
      h('div', { class: 'big-emoji' }, '🎸'),
      h('h2', {}, 'Zatím tu nic není'),
      h('p', {}, shared ? 'Buď první, kdo sem přidá písničku.' : 'Přidej první song, nebo si nahraj ukázku a zkus si, jak to funguje.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary big', onclick: addSong }, '+ Přidat song'),
        !shared && h('button', { class: 'btn big', onclick: addDemo }, 'Nahrát ukázku'))));
    app.append(wrap);
    return;
  }

  const grid = h('div', { class: 'grid' });
  const search = h('input', {
    class: 'search', type: 'search', placeholder: 'Hledat song nebo interpreta…', value: searchQ,
    oninput: e => { searchQ = e.target.value; fillGrid(); },
  });
  wrap.append(h('div', { class: 'lib-tools' }, search), grid);

  function fillGrid() {
    grid.innerHTML = '';
    const q = searchQ.trim().toLowerCase();
    const list = [...songs]
      .sort((a, b) => (b.updated || 0) - (a.updated || 0))
      .filter(s => !q || (s.title + ' ' + (s.artist || '') + ' ' + (s.author || '')).toLowerCase().includes(q));
    if (!list.length) grid.append(h('p', { style: 'color:var(--muted)' }, 'Nic nenalezeno.'));
    list.forEach(s => {
      const color = CARD_COLORS[mod(songs.indexOf(s)) % CARD_COLORS.length];
      const secs = [...new Set(s.lines.map(l => l.section).filter(Boolean))];
      const chordCount = s.lines.reduce((n, l) => n + l.chords.length, 0);
      grid.append(h('article', {
        class: 'card', style: `--card-c: var(${color})`, tabindex: 0,
        onclick: () => go('#song-' + s.id),
        onkeydown: e => { if (e.key === 'Enter') go('#song-' + s.id); },
      },
        canEdit(s) && h('button', {
          class: 'del', title: 'Smazat song', 'aria-label': 'Smazat song',
          onclick: e => {
            e.stopPropagation();
            const idx = songs.indexOf(s);
            songs = songs.filter(x => x !== s);
            saveSongs(); renderLibrary();
            toast(`„${s.title}“ smazán`, 'Zpět', () => { songs.splice(Math.min(idx, songs.length), 0, s); saveSongs(); renderLibrary(); });
          },
        }, '×'),
        h('h3', {}, s.title || 'Bez názvu'),
        h('div', { class: 'artist' }, s.artist || '—'),
        h('div', { class: 'meta' },
          h('span', { class: 'badge key' }, keyPair(s.key)),
          s.isPublic === false && h('span', { class: 'badge', title: 'Vidíš jen ty' }, '🔒'),
          s.author && h('span', { class: 'badge author', title: 'Přidal(a)' }, s.author),
          h('span', { class: 'badge' }, chordCount + ' akordů'),
          h('span', { class: 'sec-dots' }, secs.map(t => h('i', { 'data-s': t, style: 'background:var(--sc)', title: secLabel(t) }))))));
    });
  }
  fillGrid();
  app.append(wrap);
}

function addDemo() {
  const raw = `[Intro]
[G]    [D]    [Em]    [C]

[Sloka]
[G]Ráno vstanu, [D]vezmu kytaru do [Em]ruky,
[C]první struna zvoní, [G]ladím tóny a [D]zvuky.
[G]Káva voní, [D]prsty běhaj po [Em]pražcích,
[C]celej svět se točí [D]v pár jednoduchejch [G]taktech.

[Refrén]
[C]Hraj to s Bobem, [G]ať to slyší celej [D]dům,
[Em]hraj to s Bobem, [C]dneska patří všechno [D]nám.

[Sloka]
Večer sedíme a oheň praská do tmy,
každej zpívá falešně, ale nikdo to nevnímá.

[Outro]
[C]    [D]    [G]`;
  const lines = parseLyrics(raw);
  const song = { id: uid(), title: 'Písnička pro Boba', artist: 'Ukázka', key: guessKey(lines) || { root: 7, minor: false }, lines, custom: [], updated: Date.now() };
  songs.push(song);
  saveSongs();
  go('#song-' + song.id);
}

async function exportSongs() {
  const json = JSON.stringify({ app: 'kytara-s-bobem', version: 1, songs }, null, 2);
  const filename = 'kytara-s-bobem-zaloha.json';
  const dl = window.claude?.use ? await window.claude.use('downloads').catch(() => null) : null;
  if (dl) {
    try { await dl.save({ filename, data: json }); } catch { toast('Záloha se neuložila'); }
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importSongs() {
  const inp = h('input', { type: 'file', accept: '.json,application/json' });
  inp.onchange = async () => {
    try {
      const data = JSON.parse(await inp.files[0].text());
      const list = Array.isArray(data) ? data : data.songs;
      if (!Array.isArray(list)) throw new Error();
      let added = 0;
      for (const s of list) {
        if (!s || !Array.isArray(s.lines) || !s.key) continue;
        const existing = songs.findIndex(x => x.id === s.id);
        if (existing >= 0) songs[existing] = s;
        else songs.push({ ...s, id: /^[A-Za-z0-9]{1,40}$/.test(s.id || '') ? s.id : uid(), updated: Date.now() });
        added++;
      }
      saveSongs(); renderLibrary(); toast(`Nahráno ${added} songů`);
    } catch { toast('Tohle nevypadá jako záloha Kytary s Bobem'); }
  };
  inp.click();
}

// =========================================================
//  MODAL: PŘIDAT / UPRAVIT SONG
// =========================================================
function closeModal() { $('#modalRoot').innerHTML = ''; }

function openSongModal(existing = null) {
  const root = $('#modalRoot');
  const st = {
    step: 1,
    title: existing?.title || '',
    artist: existing?.artist || '',
    text: existing ? existing.lines.map(l => l.text).join('\n') : '',
    lines: null, guess: null, key: null, minor: false,
  };

  const back = h('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) closeModal(); } });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' });
  back.append(modal);
  root.innerHTML = '';
  root.append(back);

  function step1() {
    modal.innerHTML = '';
    const title = h('input', { value: st.title, placeholder: 'Např. Písnička pro Boba', oninput: e => (st.title = e.target.value) });
    const artist = h('input', { value: st.artist, placeholder: 'Kdo to hraje', oninput: e => (st.artist = e.target.value) });
    const text = h('textarea', {
      placeholder: 'Sem vlož text písničky…\n\nKlidně i s akordy nad řádky nebo v [hranatých] závorkách,\na se značkami jako [Refrén], R: nebo 1.',
      oninput: e => (st.text = e.target.value),
    });
    text.value = st.text;
    modal.append(
      !existing && h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i')),
      h('h2', {}, existing ? 'Upravit text' : 'Nový song'),
      h('p', { class: 'sub' }, existing ? 'Akordy a části zůstanou na stejných řádcích.' : 'Krok 1 ze 2 — vlož text.'),
      h('div', { class: 'two' },
        h('label', { class: 'field' }, h('span', {}, 'Název'), title),
        h('label', { class: 'field' }, h('span', {}, 'Interpret'), artist)),
      h('label', { class: 'field' }, h('span', {}, 'Text'), text),
      !existing && h('div', { class: 'hint' },
        '💡 Stačí holý text — akordy pak přetáhneš myší. Když vložíš text ', h('b', {}, 's akordy'),
        ' (nad řádky, nebo jako [Am]), poznám je a odhadnu tóninu.'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: closeModal }, 'Zrušit'),
        h('button', { class: 'btn primary', onclick: next }, existing ? 'Uložit text' : 'Pokračovat → tónina')));
    setTimeout(() => (existing ? text : title).focus(), 30);
  }

  function next() {
    if (!st.text.trim()) { toast('Nejdřív vlož nějaký text 🙂'); return; }
    if (existing) { applyTextEdit(existing, st); closeModal(); return; }
    st.lines = parseLyrics(st.text);
    st.guess = guessKey(st.lines);
    const k = st.guess || { root: 7, minor: false };
    st.key = k.root; st.minor = k.minor;
    st.step = 2;
    step2();
  }

  function step2() {
    modal.innerHTML = '';
    const key = { root: st.key, minor: st.minor };
    const found = st.lines.reduce((n, l) => n + l.chords.length, 0);
    const secs = st.lines.filter(l => l.section).length;
    modal.append(
      h('div', { class: 'steps' }, h('i', { class: 'on' }), h('i', { class: 'on' })),
      h('h2', {}, 'Vyber tóninu'),
      h('p', { class: 'sub' }, 'Krok 2 ze 2 — podle tóniny ti připravím akordy na přetahování.'),
      st.guess
        ? h('div', { class: 'guess' }, h('span', { style: 'font-size:30px' }, '🎯'),
            h('div', {}, h('div', { style: 'font-size:13px;color:var(--muted);font-weight:600' }, `Našel jsem ${found} akordů${secs ? ` a ${secs} částí` : ''}. Odhaduju:`),
              h('div', { class: 'big' }, keyBoth(st.guess))))
        : h('div', { class: 'guess' }, h('span', { style: 'font-size:30px' }, '🎸'),
            h('div', {}, h('div', { style: 'font-weight:700' }, 'Text je bez akordů – vyber, v čem chceš hrát.'),
              h('div', { style: 'font-size:13px;color:var(--muted)' }, `★ = tóniny, které jdou na kytaru nejlíp${secs ? ` · našel jsem ${secs} částí` : ''}`))),
      audioPanel(st.audio || (st.audio = {}), (k, capo) => { st.key = k.root; st.minor = k.minor; st.capo = capo || 0; step2(); },
        title => { if (!st.title.trim()) st.title = title; }),
      keyPicker(key, k => { st.key = k.root; st.minor = k.minor; st.capo = 0; step2(); }),
      st.capo ? h('p', { class: 'capo-note' }, `🎸 Hraješ s kapodastrem na ${st.capo}. pražci (zní to v ${keyName(transposeKey(key, st.capo))}).`) : null,
      h('div', { class: 'key-preview' },
        h('div', { class: 'lbl' }, `Akordy v ${keyBoth(key)}:`),
        h('div', { class: 'chips' }, paletteFor(key).main.map(c =>
          h('span', { class: 'chip static ' + degClass(c.root, key) }, chordName(c, key), h('small', {}, c.roman))))),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn ghost', onclick: () => { st.step = 1; step1(); } }, '← Zpět'),
        h('button', { class: 'btn rainbow', onclick: create }, 'Vytvořit song ✨')));
  }

  function create() {
    const song = {
      id: uid(),
      title: st.title.trim() || 'Bez názvu',
      artist: st.artist.trim(),
      key: { root: st.key, minor: st.minor },
      capo: st.capo || 0,
      lines: st.lines,
      custom: [],
      updated: Date.now(),
    };
    songs.push(song);
    saveSongs();
    closeModal();
    go('#song-' + song.id);
  }

  step1();
}

function applyTextEdit(song, st) {
  pushUndo(song);
  const newLines = st.text.replace(/\r/g, '').split('\n').map(t => t.replace(/\s+$/, ''));
  song.lines = newLines.map((text, i) => {
    const old = song.lines[i];
    return {
      text,
      chords: old ? normalizeChords(old.chords.filter(c => c.pos <= Math.max(text.length + 2, 30))) : [],
      section: old ? old.section : null,
    };
  });
  song.title = st.title.trim() || song.title;
  song.artist = st.artist.trim();
  touch(song);
  renderEditor();
  toast('Text uložen', 'Zpět', undo);
}

// =========================================================
//  TÓNINA Z NAHRÁVKY (MP3 / YouTube přes lokálního pomocníka)
// =========================================================
const HELPER = 'http://127.0.0.1:5174';
const EASY = { major: [7, 2, 0, 9, 4], minor: [4, 9, 2] };   // G D C A E · Em Am Dm
const transposeKey = (key, n) => ({ root: mod(key.root + n), minor: key.minor });

/** Když tónina není kytarově pohodlná, najdi nejnižší kapodastr s pohodlným tvarem. */
function capoTip(key) {
  const easy = key.minor ? EASY.minor : EASY.major;
  if (easy.includes(key.root)) return null;
  for (let capo = 1; capo <= 7; capo++) {
    const shape = transposeKey(key, -capo);
    if (easy.includes(shape.root)) return { capo, shape };
  }
  return null;
}

let helperState = null;   // null = neověřeno, true/false
async function helperAlive() {
  if (helperState !== null) return helperState;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1200);
    const r = await fetch(HELPER + '/health', { signal: ctrl.signal });
    clearTimeout(t);
    helperState = r.ok;
  } catch { helperState = false; }
  setTimeout(() => { helperState = null; }, 15000);   // za chvíli zkus znovu
  return helperState;
}

/**
 * Panel „Poznat z nahrávky“. `state` přežije překreslení modalu.
 * onPick(key, capo) – zvolená tónina; onTitle(title) – název z YouTube
 */
function audioPanel(state, onPick, onTitle) {
  const box = h('div', { class: 'audio-box' + (state.busy ? ' busy' : '') });
  const status = h('div', { class: 'audio-status', role: 'status' }, state.status || '');
  const results = h('div', { class: 'audio-results' });

  const setStatus = (t, err) => { state.status = t; status.textContent = t; status.classList.toggle('err', !!err); };
  const setBusy = b => { state.busy = b; box.classList.toggle('busy', b); };

  async function run(getBuffer, label) {
    if (state.busy) return;
    setBusy(true);
    try {
      setStatus(label);
      const buf = await getBuffer();
      setStatus('🎧 Poslouchám…');
      const res = await KeyDetect.analyze(buf, p => setStatus(`🎧 Poslouchám… ${Math.round(p * 100)} %`));
      state.results = res.keys.map(k => ({ key: k.key, pct: k.pct }));
      state.tuning = res.tuningCents;
      setStatus(`Hotovo · nahrávka ${fmtTime(res.duration)}${Math.abs(res.tuningCents) > 25 ? ` · ladění ${res.tuningCents > 0 ? '+' : ''}${res.tuningCents} centů` : ''}`);
      drawResults();
    } catch (e) {
      setStatus(e?.userMessage || 'Tuhle nahrávku se nepodařilo přečíst. Zkus jiný soubor (mp3, m4a, wav).', true);
    } finally { setBusy(false); }
  }

  const fileIn = h('input', { type: 'file', accept: 'audio/*,.mp3,.m4a,.wav,.ogg,.flac,.webm', hidden: true });
  fileIn.onchange = () => {
    const f = fileIn.files[0];
    if (!f) return;
    state.source = f.name;
    if (onTitle) onTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' '));
    run(() => f.arrayBuffer(), `Načítám ${f.name}…`);
  };

  const ytIn = h('input', { type: 'url', class: 'yt-input', placeholder: 'nebo vlož YouTube odkaz…', value: state.yt || '', oninput: e => (state.yt = e.target.value) });
  const ytForm = h('form', {
    class: 'yt-form',
    onsubmit: async e => {
      e.preventDefault();
      const url = ytIn.value.trim();
      if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(url)) { setStatus('Tohle nevypadá jako odkaz na YouTube.', true); return; }
      if (!(await helperAlive())) {
        setStatus(location.protocol === 'https:'
          ? 'Pomocník nereaguje. Spusť „spustit-pomocnika.bat“ a až se prohlížeč zeptá na přístup k místní síti, povol ho. Případně otevři appku na http://127.0.0.1:5174/.'
          : 'YouTube potřebuje pomocníka na tvém počítači: spusť „spustit-pomocnika.bat“ a zkus to znovu.', true);
        return;
      }
      run(async () => {
        const r = await fetch(HELPER + '/audio?url=' + encodeURIComponent(url));
        if (!r.ok) {
          let msg = 'Stažení z YouTube se nepovedlo.';
          try { msg = (await r.json()).error || msg; } catch { /* nic */ }
          throw { userMessage: msg };
        }
        const title = decodeURIComponent(r.headers.get('X-Title') || '');
        if (title && onTitle) onTitle(title);
        setStatus('⬇ Staženo, připravuju…');
        return r.arrayBuffer();
      }, '⬇ Stahuju zvuk z YouTube…');
    },
  }, ytIn, h('button', { class: 'btn', type: 'submit' }, 'Poznat'));

  function drawResults() {
    results.innerHTML = '';
    if (!state.results) return;
    state.results.forEach((r, i) => {
      const tip = capoTip(r.key);
      results.append(h('div', { class: 'audio-result' + (i === 0 ? ' best' : '') },
        h('button', { class: 'res-key', onclick: () => onPick(r.key, 0), title: 'Použít tuhle tóninu' },
          h('span', { class: 'res-name' }, keyName(r.key), h('small', {}, ' / ' + keyShort(relKey(r.key)))),
          h('span', { class: 'res-pct' }, r.pct + ' %'),
          h('span', { class: 'res-bar', style: `--w:${Math.max(4, r.pct)}%` })),
        tip && h('button', {
          class: 'res-capo', onclick: () => onPick(tip.shape, tip.capo),
          title: `Hraj tvary z ${keyName(tip.shape)} s kapodastrem`,
        }, `🎸 kapo ${tip.capo} → ${keyShort(tip.shape)}`)));
    });
  }

  // přetažení souboru na panel
  box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('over'); });
  box.addEventListener('dragleave', () => box.classList.remove('over'));
  box.addEventListener('drop', e => {
    e.preventDefault(); box.classList.remove('over');
    const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('audio') || /\.(mp3|m4a|wav|ogg|flac|webm)$/i.test(f.name));
    if (f) { const dt = new DataTransfer(); dt.items.add(f); fileIn.files = dt.files; fileIn.onchange(); }
  });

  box.append(
    h('div', { class: 'audio-head' },
      h('b', {}, '🎧 Poznat tóninu z nahrávky'),
      h('span', {}, 'Soubor zůstane jen u tebe, nikam se neposílá.')),
    h('div', { class: 'audio-row' },
      h('button', { class: 'btn primary', type: 'button', onclick: () => fileIn.click() }, '⬆ Nahrát MP3'),
      ytForm),
    fileIn, status, results);
  drawResults();
  return box;
}
const fmtTime = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

function openAudioModal(song) {
  const root = $('#modalRoot');
  const state = {};
  const back = h('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) closeModal(); } });
  const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
    h('h2', {}, 'Tónina z nahrávky'),
    h('p', { class: 'sub' }, 'Nahraj písničku nebo vlož YouTube odkaz. Vybraná tónina změní nabídku akordů.'),
    audioPanel(state, (k, capo) => {
      pushUndo(song);
      song.key = k; song.capo = capo || 0;
      touch(song); closeModal(); renderEditor();
      toast(`Tónina: ${keyBoth(k)}${capo ? ` · kapo ${capo}` : ''}`, 'Zpět', undo);
    }),
    h('div', { class: 'modal-actions' }, h('span'), h('button', { class: 'btn ghost', onclick: closeModal }, 'Zavřít')));
  back.append(modal);
  root.innerHTML = '';
  root.append(back);
}

/** mřížka 12 tónin + přepínač dur/moll */
function keyPicker(key, onPick) {
  const box = h('div');
  const seg = h('div', { class: 'seg' },
    h('button', { class: !key.minor ? 'on' : '', onclick: () => onPick({ root: key.root, minor: false }) }, 'Dur'),
    h('button', { class: key.minor ? 'on' : '', onclick: () => onPick({ root: key.root, minor: true }) }, 'Moll'));
  const grid = h('div', { class: 'key-grid' });
  for (let r = 0; r < 12; r++) {
    const k = { root: r, minor: key.minor };
    grid.append(h('button', {
      class: 'key-btn' + (isRecommended(k) ? ' rec' : '') + (r === key.root ? ' on' : ''),
      onclick: () => onPick(k),
    }, keyShort(k), h('small', { class: 'rel' }, keyShort(relKey(k)))));
  }
  box.append(seg, grid);
  return box;
}

// =========================================================
//  EDITOR / HRANÍ
// =========================================================
function renderEditor() {
  const song = current();
  if (!song) return;
  const play = isPlay(song);
  const editable = canEdit(song);
  const app = $('#app');
  const scrollY = window.scrollY;
  app.innerHTML = '';

  renderTopActions([
    h('a', { class: 'btn ghost', href: '#' }, '← Songy'),
  ]);

  const ed = h('div', { class: 'editor ' + (play ? 'play' : 'edit') + (armed ? ' arming' : '') });

  // hlavička
  const titleIn = h('input', { class: 'title-input', value: song.title, 'aria-label': 'Název', oninput: e => { song.title = e.target.value; touch(song); } });
  const artistIn = h('input', { class: 'artist-input', value: song.artist || '', placeholder: 'Interpret', 'aria-label': 'Interpret', oninput: e => { song.artist = e.target.value; touch(song); } });

  const controls = h('div', { class: 'controls' },
    h('button', { class: 'key-pill', title: 'Změnit tóninu (nabídku akordů)', onclick: e => openKeyPopover(e.currentTarget) },
      h('small', {}, 'Tónina'), keyName(song.key), h('small', {}, '/ ' + keyShort(relKey(song.key)))),
    song.capo ? h('button', {
      class: 'capo-pill', title: play ? `Kapodastr na ${song.capo}. pražci` : 'Klikni pro odebrání kapodastru',
      onclick: () => { if (play) return; pushUndo(song); song.capo = 0; touch(song); renderEditor(); toast('Kapodastr odebrán', 'Zpět', undo); },
    }, `Kapo ${song.capo}`) : null,
    !play && h('button', { class: 'btn', onclick: () => openAudioModal(song), title: 'Poznat tóninu z MP3 nebo YouTube' }, '🎧 Z nahrávky'),
    h('div', { class: 'tgroup', title: 'Transpozice – posune všechny akordy' },
      h('button', { onclick: () => transpose(-1), 'aria-label': 'Transponovat dolů' }, '−'),
      h('span', {}, 'transp.'),
      h('button', { onclick: () => transpose(1), 'aria-label': 'Transponovat nahoru' }, '+')),
    play && h('div', { class: 'tgroup', title: 'Velikost písma' },
      h('button', { onclick: () => setFont(-1) }, 'A−'),
      h('button', { onclick: () => setFont(1) }, 'A+')),
    play && h('div', { class: 'tgroup', title: 'Automatické posouvání' },
      h('button', { class: autoscroll.on ? 'on' : '', id: 'asBtn', onclick: toggleAutoscroll }, autoscroll.on ? '⏸' : '⏬'),
      h('button', { onclick: () => setSpeed(-1) }, '−'),
      h('span', { id: 'asSpeed' }, 'rychlost ' + autoscroll.speed),
      h('button', { onclick: () => setSpeed(1) }, '+')),
    !play && h('button', { class: 'btn', onclick: () => openSongModal(song) }, '✎ Text'),
    !play && h('button', { class: 'btn', onclick: copyText, title: 'Zkopírovat jako text s akordy' }, '⧉ Kopírovat'),
    !play && auth.mode === 'supabase' && h('button', {
      class: 'btn', title: song.isPublic === false ? 'Teď ho vidíš jen ty. Klikni pro zveřejnění.' : 'Teď ho vidí všichni. Klikni a uvidíš ho jen ty.',
      onclick: () => {
        song.isPublic = song.isPublic === false;
        touch(song); renderEditor();
        toast(song.isPublic ? 'Song je veřejný' : 'Song vidíš jen ty');
      },
    }, song.isPublic === false ? '🔒 Jen pro mě' : '🌍 Veřejný'),
    play
      ? (editable ? h('a', { class: 'btn primary', href: '#song-' + song.id }, '✎ Upravit') : null)
      : h('a', { class: 'btn rainbow', href: '#play-' + song.id }, '▶ Hrát'));

  ed.append(h('div', { class: 'song-head' },
    h('div', { class: 'titles' }, titleIn, artistIn,
      song.author && auth.mode === 'supabase' ? h('div', { class: 'by' }, 'přidal(a) ', h('b', {}, song.author)) : null),
    controls));

  if (!play) ed.append(renderPalette(song));
  const sheet = h('div', { class: 'sheet', id: 'sheet' });
  ed.append(h('div', { class: 'sheet-wrap' }, sheet));
  app.append(ed);
  renderSheet();
  window.scrollTo(0, scrollY);
}

function renderPalette(song) {
  const key = song.key;
  const pal = paletteFor(key);
  const chordChip = (c, extraLabel) => {
    const el = h('button', {
      class: 'chip ' + degClass(c.root, key) + (armed && sameChord(armed, c) ? ' armed' : ''),
      title: 'Přetáhni nad slovo, nebo klikni a pak klikni do textu',
    }, chordName(c, key), extraLabel && h('small', {}, extraLabel));
    el.addEventListener('pointerdown', e => startDrag(e, {
      kind: 'chord', chord: { root: c.root, q: c.q, bass: c.bass ?? null },
      label: chordName(c, key), cls: degClass(c.root, key),
      onClick: () => { armed = armed && sameChord(armed, c) ? null : { root: c.root, q: c.q, bass: c.bass ?? null }; renderEditor(); },
    }));
    return el;
  };
  const secChip = s => {
    const el = h('button', { class: 'chip sec', 'data-s': s.type, title: 'Přetáhni na řádek, kde část začíná' }, s.label);
    el.addEventListener('pointerdown', e => startDrag(e, {
      kind: 'section', type: s.type, label: s.label, sec: s.type,
      onClick: () => toast('Chyť ji a přetáhni na první řádek části 👆'),
    }));
    return el;
  };
  const custom = song.custom || [];
  return h('aside', { class: 'palette' },
    h('div', { class: 'group' }, h('h4', {}, 'Části písně'), h('div', { class: 'chips' }, SECTIONS.map(secChip))),
    h('div', { class: 'group' }, h('h4', {}, `Akordy · ${keyBoth(key)}`), h('div', { class: 'chips' }, pal.main.map(c => chordChip(c, c.roman)))),
    h('div', { class: 'group' }, h('h4', {}, 'Další barvy'), h('div', { class: 'chips' }, pal.extra.map(c => chordChip(c)))),
    h('div', { class: 'group' }, h('h4', {}, 'Vlastní'), h('div', { class: 'chips' },
      custom.map(c => chordChip(c)),
      h('button', { class: 'chip add', onclick: e => openChordBuilder(e.currentTarget) }, '+ akord'))),
    h('div', { class: 'tip' },
      h('b', {}, 'Přetáhni'), ' akord nad slabiku, nebo ho ', h('b', {}, 'klikni'), ' a pak klikej do textu. ',
      'Klik na akord v textu = změna, odtažení pryč = smazání. ', h('b', {}, 'Ctrl+Z'), ' vrátí krok.'));
}
const sameChord = (a, b) => a.root === b.root && (a.q || '') === (b.q || '') && (a.bass ?? null) === (b.bass ?? null);

function renderSheet() {
  const song = current();
  const sheet = $('#sheet');
  if (!song || !sheet) return;
  const play = isPlay(song);
  sheet.innerHTML = '';
  let sec = null;
  const counts = {};

  if (!song.lines.length) {
    sheet.append(h('p', { style: 'color:var(--muted)' }, 'Song je prázdný. Klikni na „✎ Text“ a vlož ho.'));
  }

  song.lines.forEach((line, li) => {
    if (line.section) {
      sec = line.section;
      counts[sec] = (counts[sec] || 0) + 1;
      const total = song.lines.filter(l => l.section === sec).length;
      const label = secLabel(sec) + (sec === 'verse' && total > 1 ? ' ' + counts[sec] : '');
      const lab = h('div', { class: 'sec-label', 'data-s': sec, title: play ? '' : 'Klikni pro změnu, táhni pro přesun' }, label);
      if (!play) {
        lab.addEventListener('pointerdown', e => startDrag(e, {
          kind: 'moveSection', li, type: sec, label: secLabel(sec), sec,
          onClick: () => openSectionPopover(lab, li),
        }));
      }
      sheet.append(h('div', {}, lab));
    }
    const empty = !line.text && !line.chords.length;
    if (play && empty) { sheet.append(h('div', { class: 'gap' })); return; }

    const maxPos = line.chords.reduce((m, c) => Math.max(m, c.pos + 1), 0);
    let len = Math.max(line.text.length, maxPos);
    if (!play) len = line.text ? Math.max(len, line.text.length + 4) : Math.max(len + 3, innerWidth < 600 ? 14 : 28);
    else if (!line.text) len = Math.max(len, 1);

    const lineEl = h('div', {
      class: 'line' + (empty ? ' empty-line' : '') + (!line.text ? ' instr' : ''),
      'data-li': li, 'data-s': sec || null,
    });
    const byPos = new Map(line.chords.map(c => [c.pos, c]));
    for (let i = 0; i < len; i++) {
      const ch = i < line.text.length ? line.text[i] : null;
      const span = h('span', { class: 'c' + (ch == null ? ' pad' : ''), 'data-i': i }, ch == null ? ' ' : ch);
      const chord = byPos.get(i);
      if (chord) {
        const ce = h('span', { class: 'chord ' + degClass(chord.root, song.key) }, chordName(chord, song.key));
        if (!play) {
          ce.addEventListener('pointerdown', e => {
            e.stopPropagation();
            startDrag(e, {
              kind: 'moveChord', li, pos: i, chord: { root: chord.root, q: chord.q, bass: chord.bass ?? null },
              label: chordName(chord, song.key), cls: degClass(chord.root, song.key), srcEl: ce,
              onClick: () => openChordPopover(ce, li, i),
            });
          });
        }
        span.append(ce);
      }
      lineEl.append(span);
    }
    if (!play) {
      lineEl.append(h('span', { class: 'line-tools', contenteditable: 'false' },
        h('button', { title: 'Vložit prázdný řádek pod (třeba pro intro/mezihru)', onclick: () => insertLine(li + 1) }, '+'),
        h('button', { title: 'Smazat řádek', onclick: () => deleteLine(li) }, '×')));
    }
    sheet.append(lineEl);
  });

  if (!play) {
    sheet.onclick = e => {
      if (!armed) return;
      const c = e.target.closest('.c');
      const l = e.target.closest('.line');
      if (!c || !l || e.target.closest('.chord')) return;
      placeChord(+l.dataset.li, +c.dataset.i, armed);
    };
  }
}

// ---------- mutace ----------
function placeChord(li, pos, chord) {
  const song = current();
  pushUndo(song);
  const line = song.lines[li];
  line.chords = line.chords.filter(c => c.pos !== pos);
  line.chords.push({ pos, root: chord.root, q: chord.q || '', bass: chord.bass ?? null });
  line.chords.sort((a, b) => a.pos - b.pos);
  touch(song);
  renderSheet();
}
function insertLine(at) {
  const song = current();
  pushUndo(song);
  song.lines.splice(at, 0, { text: '', chords: [], section: null });
  touch(song); renderSheet();
}
function deleteLine(li) {
  const song = current();
  pushUndo(song);
  const [removed] = song.lines.splice(li, 1);
  if (removed.section && song.lines[li] && !song.lines[li].section) song.lines[li].section = removed.section;
  touch(song); renderSheet();
  toast('Řádek smazán', 'Zpět', undo);
}
function transpose(n) {
  const song = current();
  pushUndo(song);
  const sh = c => { c.root = mod(c.root + n); if (c.bass != null) c.bass = mod(c.bass + n); };
  song.lines.forEach(l => l.chords.forEach(sh));
  (song.custom || []).forEach(sh);
  song.key.root = mod(song.key.root + n);
  if (armed) sh(armed);
  touch(song);
  renderEditor();
}
function setFont(d) {
  settings.fontSize = Math.min(32, Math.max(14, settings.fontSize + d * 2));
  saveSettings();
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
}
async function copyText() {
  const song = current();
  const txt = `${song.title}${song.artist ? ' – ' + song.artist : ''}\nTónina: ${keyBoth(song.key)}\n\n` + songToText(song);
  try { await navigator.clipboard.writeText(txt); toast('Zkopírováno do schránky'); }
  catch { toast('Kopírování se nepovedlo'); }
}

// ---------- autoscroll ----------
function toggleAutoscroll() {
  autoscroll.on ? stopAutoscroll() : startAutoscroll();
  const b = $('#asBtn');
  if (b) { b.textContent = autoscroll.on ? '⏸' : '⏬'; b.classList.toggle('on', autoscroll.on); }
}
function startAutoscroll() {
  autoscroll.on = true; autoscroll.last = performance.now(); autoscroll.acc = 0;
  const step = t => {
    if (!autoscroll.on) return;
    autoscroll.acc += (t - autoscroll.last) * autoscroll.speed * 0.012;
    autoscroll.last = t;
    if (autoscroll.acc >= 1) { const px = Math.floor(autoscroll.acc); window.scrollBy(0, px); autoscroll.acc -= px; }
    autoscroll.raf = requestAnimationFrame(step);
  };
  autoscroll.raf = requestAnimationFrame(step);
}
function stopAutoscroll() { autoscroll.on = false; cancelAnimationFrame(autoscroll.raf); }
function setSpeed(d) {
  autoscroll.speed = Math.min(10, Math.max(1, autoscroll.speed + d));
  const s = $('#asSpeed'); if (s) s.textContent = 'rychlost ' + autoscroll.speed;
}

// =========================================================
//  DRAG & DROP (pointer events → myš i dotyk)
// =========================================================
let drag = null;

function startDrag(e, payload) {
  if (e.button !== 0 && e.pointerType === 'mouse') return;
  e.preventDefault();
  closePopover();
  drag = { payload, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, started: false, ghost: null, target: null, raf: 0 };
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', cancelDrag);
}

function onDragMove(e) {
  if (!drag) return;
  drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.started) {
    if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < 6) return;
    beginDragVisual();
  }
  updateDrag();
}

function beginDragVisual() {
  const p = drag.payload;
  drag.started = true;
  document.body.classList.add('dragging');
  const isSec = p.kind === 'section' || p.kind === 'moveSection';
  drag.ghost = h('div', { class: 'chip drag-ghost ' + (isSec ? 'sec' : p.cls), 'data-s': p.sec || null }, p.label);
  document.body.append(drag.ghost);
  if (p.srcEl) p.srcEl.classList.add('ghosted');
  if (p.kind === 'moveChord' || p.kind === 'moveSection') $('#trash').classList.add('show');
  const loop = () => {   // automatické rolování u kraje okna
    if (!drag) return;
    const edge = 70;
    if (drag.y < edge + 60) window.scrollBy(0, -Math.ceil((edge + 60 - drag.y) / 6));
    else if (drag.y > innerHeight - edge) window.scrollBy(0, Math.ceil((drag.y - (innerHeight - edge)) / 6));
    updateDrag();
    drag.raf = requestAnimationFrame(loop);
  };
  drag.raf = requestAnimationFrame(loop);
}

function updateDrag() {
  const p = drag.payload;
  drag.ghost.style.left = drag.x + 'px';
  drag.ghost.style.top = drag.y + 'px';
  clearTargets();
  const trash = $('#trash');
  const overTrash = trash.classList.contains('show') && hitRect(trash.getBoundingClientRect(), drag.x, drag.y, 20);
  trash.classList.toggle('hot', overTrash);
  if (overTrash) { drag.target = null; return; }

  if (p.kind === 'chord' || p.kind === 'moveChord') {
    drag.target = findCharTarget(drag.x, drag.y);
    if (drag.target) drag.target.el.classList.add('target');
  } else {
    drag.target = findLineTarget(drag.x, drag.y);
    if (drag.target) {
      drag.target.el.classList.add('sec-target');
      drag.target.el.style.setProperty('--drag-c', `var(--s-${p.type})`);
    }
  }
}

function clearTargets() {
  $$('.c.target').forEach(el => el.classList.remove('target'));
  $$('.line.sec-target').forEach(el => el.classList.remove('sec-target'));
}
const hitRect = (r, x, y, pad = 0) => x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;

function nearestLine(x, y) {
  const sheet = $('#sheet');
  if (!sheet) return null;
  if (!hitRect(sheet.getBoundingClientRect(), x, y, 50)) return null;
  let best = null;
  for (const l of $$('.line', sheet)) {
    const r = l.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (!best || d < best.d) best = { l, d };
    if (d === 0) break;
  }
  return best && best.d < 40 ? best.l : null;
}

function findCharTarget(x, y) {
  const lineEl = nearestLine(x, y);
  if (!lineEl) return null;
  let best = null;
  for (const c of lineEl.querySelectorAll('.c')) {
    for (const r of c.getClientRects()) {
      const cy = r.top + r.height / 2 - 10;   // akordy sedí nad písmenem → cíl je kousek výš
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = Math.abs(y - cy);
      const d = dx + dy * 1.6;
      if (!best || d < best.d) best = { c, d };
    }
  }
  return best ? { li: +lineEl.dataset.li, pos: +best.c.dataset.i, el: best.c } : null;
}

function findLineTarget(x, y) {
  const l = nearestLine(x, y);
  return l ? { li: +l.dataset.li, el: l } : null;
}

function onDragEnd() {
  if (!drag) return;
  const d = drag;
  teardownDrag();
  const p = d.payload;
  if (!d.started) { p.onClick && p.onClick(); return; }
  const song = current();
  if (!song) return;
  const t = d.target;

  if (p.kind === 'chord') {
    if (t) placeChord(t.li, t.pos, p.chord);
  } else if (p.kind === 'moveChord') {
    if (t && t.li === p.li && t.pos === p.pos) { renderSheet(); return; }
    pushUndo(song);
    const src = song.lines[p.li];
    src.chords = src.chords.filter(c => c.pos !== p.pos);
    if (t) {
      const dst = song.lines[t.li];
      dst.chords = dst.chords.filter(c => c.pos !== t.pos);
      dst.chords.push({ pos: t.pos, ...p.chord });
      dst.chords.sort((a, b) => a.pos - b.pos);
    } else toast('Akord smazán', 'Zpět', undo);
    touch(song); renderSheet();
  } else if (p.kind === 'section') {
    if (!t) return;
    pushUndo(song);
    song.lines[t.li].section = p.type;
    touch(song); renderSheet();
  } else if (p.kind === 'moveSection') {
    if (t && t.li === p.li) { renderSheet(); return; }
    pushUndo(song);
    song.lines[p.li].section = null;
    if (t) song.lines[t.li].section = p.type;
    else toast('Část odebrána', 'Zpět', undo);
    touch(song); renderSheet();
  }
}

function teardownDrag() {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  drag.ghost && drag.ghost.remove();
  drag.payload.srcEl && drag.payload.srcEl.classList.remove('ghosted');
  clearTargets();
  const trash = $('#trash');
  trash.classList.remove('show', 'hot');
  document.body.classList.remove('dragging');
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', cancelDrag);
  drag = null;
}
function cancelDrag() { teardownDrag(); }

// =========================================================
//  POPOVERY
// =========================================================
function openPopover(anchor, content) {
  const pop = $('#popover');
  pop.innerHTML = '';
  pop.append(content);
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = Math.min(Math.max(12, r.left), innerWidth - pw - 12);
  let top = r.bottom + 8;
  if (top + ph > innerHeight - 12) top = Math.max(12, r.top - ph - 8);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}
function closePopover() { const p = $('#popover'); if (p) { p.hidden = true; p.innerHTML = ''; } }
document.addEventListener('pointerdown', e => {
  const p = $('#popover');
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('.chord, .sec-label, .key-pill, .chip.add')) closePopover();
});

const QUALS = ['', 'm', '7', 'm7', 'maj7', 'sus2', 'sus4', 'add9', 'dim', 'aug', '6', '9'];

function openChordPopover(anchor, li, pos) {
  const song = current();
  const chord = song.lines[li].chords.find(c => c.pos === pos);
  if (!chord) return;
  const key = song.key;
  const set = patch => {
    pushUndo(song);
    Object.assign(chord, patch);
    touch(song); closePopover(); renderSheet();
  };
  openPopover(anchor, h('div', {},
    h('h5', {}, 'Varianta'),
    h('div', { class: 'chips' }, QUALS.map(q => {
      const c = { root: chord.root, q, bass: chord.bass };
      return h('button', { class: 'chip ' + degClass(c.root, key) + (q === chord.q ? ' armed' : ''), onclick: () => set({ q }) }, chordName(c, key));
    })),
    h('h5', { style: 'margin-top:12px' }, 'Jiný akord z tóniny'),
    h('div', { class: 'chips' }, paletteFor(key).main.map(c =>
      h('button', { class: 'chip ' + degClass(c.root, key), onclick: () => set({ root: c.root, q: c.q, bass: null }) }, chordName(c, key)))),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { closePopover(); openChordBuilder(anchor, ch => set(ch)); } }, 'Jiný…'),
      h('button', {
        class: 'btn', style: 'color:var(--d0)',
        onclick: () => {
          pushUndo(song);
          song.lines[li].chords = song.lines[li].chords.filter(c => c !== chord);
          touch(song); closePopover(); renderSheet();
        },
      }, '🗑 Smazat'))));
}

function openSectionPopover(anchor, li) {
  const song = current();
  const line = song.lines[li];
  openPopover(anchor, h('div', {},
    h('h5', {}, 'Změnit část'),
    h('div', { class: 'chips' }, SECTIONS.map(s => h('button', {
      class: 'chip sec' + (s.type === line.section ? ' armed' : ''), 'data-s': s.type,
      onclick: () => { pushUndo(song); line.section = s.type; touch(song); closePopover(); renderSheet(); },
    }, s.label))),
    h('div', { class: 'row' },
      h('span'),
      h('button', {
        class: 'btn', style: 'color:var(--d0)',
        onclick: () => { pushUndo(song); line.section = null; touch(song); closePopover(); renderSheet(); },
      }, '🗑 Odebrat'))));
}

function openKeyPopover(anchor) {
  const song = current();
  const draw = key => {
    openPopover(anchor, h('div', {},
      h('h5', {}, 'Tónina = nabídka akordů'),
      keyPicker(key, k => {
        pushUndo(song);
        song.key = k; touch(song);
        renderEditor();
        const pill = $('.key-pill');
        if (pill) { anchor = pill; draw(k); }
      }),
      h('div', { style: 'font-size:12px;color:var(--muted);margin-top:10px;max-width:280px' },
        'Mění jen paletu a barvy. Pro posun všech akordů použij transpozici − / +.')));
  };
  draw(song.key);
}

function openChordBuilder(anchor, onDone) {
  const song = current();
  const key = song.key;
  const st = { root: key.root, q: '', bass: null };
  const draw = () => {
    const preview = { ...st };
    openPopover(anchor, h('div', {},
      h('h5', {}, 'Základ'),
      h('div', { class: 'roots' }, Array.from({ length: 12 }, (_, r) => h('button', {
        class: r === st.root ? 'on' : '', onclick: () => { st.root = r; draw(); },
      }, noteName(r, key)))),
      h('h5', {}, 'Typ'),
      h('div', { class: 'quals' }, QUALS.map(q => h('button', {
        class: q === st.q ? 'on' : '', onclick: () => { st.q = q; draw(); },
      }, q || 'dur'))),
      h('h5', { style: 'margin-top:10px' }, 'Bas (volitelně)'),
      h('div', { class: 'roots' },
        h('button', { class: st.bass == null ? 'on' : '', onclick: () => { st.bass = null; draw(); } }, '–'),
        Array.from({ length: 11 }, (_, i) => { const r = mod(st.root + i + 1); return h('button', { class: st.bass === r ? 'on' : '', onclick: () => { st.bass = r; draw(); } }, noteName(r, key)); })),
      h('div', { class: 'row' },
        h('span', { class: 'chip static ' + degClass(preview.root, key) }, chordName(preview, key)),
        h('button', {
          class: 'btn primary',
          onclick: () => {
            closePopover();
            if (onDone) { onDone({ root: st.root, q: st.q, bass: st.bass }); return; }
            song.custom = song.custom || [];
            if (!song.custom.some(c => sameChord(c, st))) { pushUndo(song); song.custom.push({ ...st }); touch(song); }
            renderEditor();
          },
        }, onDone ? 'Použít' : 'Přidat do palety'))));
  };
  draw();
}

// =========================================================
//  TOAST
// =========================================================
let toastTimer = 0;
function toast(msg, actionLabel, action) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(h('span', {}, msg));
  if (actionLabel) t.append(h('button', { onclick: () => { t.classList.remove('show'); action(); } }, actionLabel));
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), actionLabel ? 4500 : 2200);
}

// =========================================================
//  KLÁVESNICE
// =========================================================
document.addEventListener('keydown', e => {
  const typing = e.target.matches('input, textarea');
  if (e.key === 'Escape') {
    if (drag) { teardownDrag(); return; }
    if (!$('#popover').hidden) { closePopover(); return; }
    if ($('#modalRoot').children.length) { closeModal(); return; }
    if (armed) { armed = null; renderEditor(); }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && route.view === 'song') {
    e.preventDefault();
    undo();
  }
  if (e.key === ' ' && !typing && route.view === 'song' && route.mode === 'play') {
    e.preventDefault();
    toggleAutoscroll();
  }
});

render();
if (window.KSB_SUPA) window.KSB_SUPA.init(); else cloud.init();
