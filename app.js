'use strict';
/* =========================================================
   playalong.cz – zpěvník s drag & drop akordy
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

// ---------- vlastní ikony (čárové SVG, barva podle textu) ----------
const ICONS = {
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="5" height="7" rx="2"/><rect x="16" y="14" width="5" height="7" rx="2"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M16 8V6a3 3 0 0 0-3-3H7a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 2.6 4 5.6 4 9s-1.2 6.4-4 9c-2.8-2.6-4-5.6-4-9s1.2-6.4 4-9z"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="3"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><circle cx="12" cy="16" r="1.2" fill="currentColor" stroke="none"/>',
  save: '<path d="M5 4h11l3 3v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="5" rx="1"/>',
  pencil: '<path d="M4 20l4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10z"/><path d="M14 7l3 3"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.8A.8.8 0 0 1 9.8 4h4.4a.8.8 0 0 1 .8.8V7"/><path d="M6.5 7l1 12.2A2 2 0 0 0 9.5 21h5a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v6M14 11v6"/>',
  guitar: '<path d="M13.6 10.4 20.2 3.8"/><path d="M18.6 2.2l3.2 3.2"/><path d="M10.4 8.6c-1.6-.7-3.6-.2-4.6 1.1-.7.9-.9 2-.6 2.9-1.6.2-2.9 1.6-3 3.3-.2 2.5 1.9 4.7 4.4 4.6 1.8-.1 3.1-1.4 3.3-3 .9.3 2 .1 2.9-.6 1.3-1 1.8-3 1.1-4.6z"/><circle cx="8.2" cy="15.8" r="1.5"/><path d="M11.4 12.6l1.6-1.6"/>',
  chords: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M5 8h14M5 13h14M9.7 3v18M14.3 3v18"/><circle cx="9.7" cy="10.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="14.3" cy="15.5" r="1.5" fill="currentColor" stroke="none"/>',
};
/** ikona jako <span> s SVG (obsah je pevný, ne od uživatele) */
function ico(name) {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = `<svg viewBox="0 0 24 24" width="1.15em" height="1.15em" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return s;
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
function saveSongs(now = false) {
  if (auth.mode === 'supabase') { window.KSB_SUPA.schedule(now ? 0 : undefined); return; }
  persist(LS_SONGS, songs);
  cloud.schedule();
}

// ---------- kdo je přihlášený a co smí ----------
// mode 'local' = vše v prohlížeči (nebo claude.ai cloud), 'supabase' = společný zpěvník
const auth = { mode: 'local', user: null, anon: false, admin: false, name: '', loading: false, localOnly: [] };
const canEdit = s => auth.mode !== 'supabase' || (!!auth.user && (auth.admin || ((!s.owner || s.owner === auth.user.id) && !s.approved)));
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
function keyName(key) { return noteName(key.root, key) + (key.minor ? 'm' : ''); }   // bez „dur/moll“ – vedle je vždy i paralelní
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
  { type: 'inter',  label: 'Mezihra' },
  { type: 'solo',   label: 'Sólo' },
  { type: 'outro',  label: 'Outro' },
];
const secLabel = t => (SECTIONS.find(s => s.type === t) || { label: t }).label;
const SEC_WORDS = [
  [/^(intro|úvod|uvod|předehra|predehra)$/i, 'intro'],
  [/^(sloka|verse|verš|vers|s|v)$/i, 'verse'],
  [/^(předrefrén|predrefren|prerefrén|prerefren|pre-?chorus|pre)$/i, 'pre'],
  [/^(refrén|refren|ref|r|chorus)$/i, 'chorus'],
  [/^(bridge|most)$/i, 'bridge'],
  [/^(mezihra|interlude|instrumental|instr)$/i, 'inter'],
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

const PRE_MIN = -8;     // nejvýš 8 míst před začátkem textu
const PRE_SLOTS = 3;    // kolik volných míst před textem ukázat v editoru
function normalizeChords(chords) {
  const out = [];
  chords.map(c => ({ ...c, pos: Math.max(PRE_MIN, c.pos | 0) }))   // záporná pozice = akord před začátkem textu
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
    const off = -Math.min(0, ...l.chords.map(c => c.pos));   // akordy před textem → odsadit text
    let s = (' '.repeat(off) + l.text).padEnd(l.chords.reduce((m, c) => Math.max(m, c.pos + off), 0), ' ');
    [...l.chords].sort((a, b) => b.pos - a.pos).forEach(c => {
      const p = c.pos + off;
      s = s.slice(0, p) + '[' + chordName(c, song.key) + ']' + s.slice(p);
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
let redoStack = [];
let historyFor = null;   // historie platí jen pro právě otevřený song
const snapshot = song => ({ id: song.id, lines: clone(song.lines), key: clone(song.key), custom: clone(song.custom || []), capo: song.capo || 0 });
function restore(song, s) { song.lines = s.lines; song.key = s.key; song.custom = s.custom; song.capo = s.capo || 0; }
function pushUndo(song) {
  undoStack.push(snapshot(song));
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];        // nová změna zahodí kroky „vpřed“
}
function undo() {
  const u = undoStack.pop();
  const song = u && songs.find(s => s.id === u.id);
  if (!song) return;
  redoStack.push(snapshot(song));
  restore(song, u);
  touch(song);
  renderEditor();
}
function redo() {
  const r = redoStack.pop();
  const song = r && songs.find(s => s.id === r.id);
  if (!song) return;
  undoStack.push(snapshot(song));
  restore(song, r);
  touch(song);
  renderEditor();
}
function updateHistoryButtons() {
  const u = $('#undoBtn'), r = $('#redoBtn');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

// =========================================================
//  ROUTER
// =========================================================
function parseHash() {
  const m = /^#(song|play|along)-([A-Za-z0-9]+)$/.exec(location.hash);
  if (m && m[1] === 'along') return { view: 'along', id: m[2], mode: 'play' };
  if (m) return { view: 'song', id: m[2], mode: m[1] === 'play' ? 'play' : 'edit' };
  return { view: 'list' };
}
function go(hash) { location.hash = hash; }
window.addEventListener('hashchange', render);

function render() {
  closePopover();
  stopAutoscroll();
  armed = null;
  const prevView = route.view;
  route = parseHash();
  if (route.view !== 'along' && typeof alongStop === 'function') alongStop();
  if (prevView !== route.view) window.scrollTo(0, 0);
  if (route.id !== historyFor || route.mode === 'edit') { viewShift = 0; viewCapo = 0; }   // transpozice ani kapo se nepřenáší
  if (route.view === 'along') viewShift = 0;   // play-along je vždy v tónině nahrávky (kapo zůstává)
  if (route.id !== historyFor) { undoStack = []; redoStack = []; historyFor = route.id || null; selection = null; caret = null; expandedRefs = new Set(); }
  const loadingSong = '<div class="wrap"><div class="empty"><div class="big-emoji">🎸</div><h2>Načítám song…</h2></div></div>';
  if ((route.view === 'song' || route.view === 'along') && !current()) {
    if (auth.loading) { $('#app').innerHTML = loadingSong; return; }
    go('#'); return;
  }
  // ze seznamu známe jen název – celou písničku dočti z databáze
  if ((route.view === 'song' || route.view === 'along') && current().partial) {
    $('#app').innerHTML = loadingSong;
    const id = route.id;
    window.KSB_SUPA.ensureLoaded(id)
      .then(() => { if (route.id === id) render(); })
      .catch(() => { toast('Song se nepodařilo načíst. Zkontroluj připojení.'); });
    return;
  }
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  if (route.view === 'along') renderAlong();
  else if (route.view === 'song') renderEditor(); else renderLibrary();
}

// =========================================================
//  TOPBAR
// =========================================================
function renderTopActions(extra = []) {
  const box = $('#topActions');
  box.innerHTML = '';
  box.append(...[
    h('span', { id: 'syncStatus', class: 'sync' }, statusText),
    ...extra,
    auth.mode === 'supabase' && (auth.user && !auth.anon
      ? h('button', {
          class: 'btn ghost user-btn', title: 'Klikni pro odhlášení',
          onclick: () => window.KSB_SUPA.logout(),
        }, '👤 ', auth.name || 'Já', auth.admin ? h('small', {}, ' admin') : null)
      : h('button', { class: 'btn primary', onclick: () => window.KSB_SUPA.openLogin() }, 'Přihlásit')),
    h('button', {
      class: 'btn ghost', title: 'Přepnout značení (česky H / anglicky B)',
      onclick: () => { settings.notation = settings.notation === 'cz' ? 'intl' : 'cz'; saveSettings(); render(); },
    }, 'Značení: ', h('b', {}, settings.notation === 'cz' ? 'H' : 'B')),
  ].filter(Boolean));
}

// =========================================================
//  KNIHOVNA
// =========================================================
const CARD_COLORS = ['--d0', '--d3', '--d4', '--d5', '--d6', '--d1', '--d2'];
let searchQ = '';

function renderLibrary() {
  const app = $('#app');
  app.innerHTML = '';
  document.body.classList.remove('playing');
  const shared = auth.mode === 'supabase';
  renderTopActions([
    canCreate() && !auth.anon && h('button', { class: 'btn ghost', onclick: exportSongs, title: 'Stáhnout zálohu songů' }, '⬇ Záloha'),
    canCreate() && !auth.anon && h('button', { class: 'btn ghost', onclick: importSongs, title: 'Nahrát zálohu' }, '⬆ Nahrát'),
  ]);

  const addSong = async () => {
    // přidat může i nepřihlášený: dostane anonymní účet, song čeká na schválení adminem
    if (shared && !auth.user) {
      try { await window.KSB_SUPA.signInAnon(); }
      catch (e) { console.warn(e); if (needLogin('Pro přidání songu se přihlas. Číst může kdokoli.')) return; }
    }
    openSongModal();
  };
  const wrap = h('div', { class: 'wrap' });
  wrap.append(h('section', { class: 'hero' },
    h('div', {},
      shared
        ? h('h1', {}, 'Společný ', h('span', { class: 'hl' }, 'zpěvník'))
        : h('h1', {}, 'Tvoje ', h('span', { class: 'hl' }, 'songy')),
      h('p', {}, shared
        ? 'Písničky s akordy pro všechny. Přidej i svoje, přihlášení není potřeba.'
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

  const grid = h('ul', { class: 'song-list' });
  const search = h('input', {
    id: 'songSearch', class: 'search', type: 'search', placeholder: 'Hledat song nebo interpreta…', value: searchQ,
    oninput: e => { searchQ = e.target.value; fillGrid(); },
  });
  wrap.append(h('div', { class: 'lib-tools' }, search), grid);

  const cz = new Intl.Collator('cs', { sensitivity: 'base' });
  function fillGrid() {
    grid.innerHTML = '';
    const q = searchQ.trim().toLowerCase();
    const list = [...songs]
      .sort((a, b) => cz.compare(a.artist || '', b.artist || '') || cz.compare(a.title || '', b.title || ''))
      .filter(s => !q || (s.title + ' ' + (s.artist || '') + ' ' + (s.author || '')).toLowerCase().includes(q));
    if (!list.length) grid.append(h('li', { class: 'none' }, 'Nic nenalezeno.'));
    list.forEach((s, i) => {
      const color = CARD_COLORS[i % CARD_COLORS.length];
      grid.append(h('li', { style: `--dot: var(${color})` },
        h('a', { class: 'song-link', href: '#play-' + s.id },
          h('span', { class: 'dot' }),
          s.artist ? h('span', { class: 'sl-artist' }, s.artist) : null,
          s.artist ? h('span', { class: 'sl-sep' }, ' – ') : null,
          h('span', { class: 'sl-title' }, s.title || 'Bez názvu'),
          s.isPublic === false ? h('span', { class: 'sl-lock', title: 'Vidíš jen ty' }, ' 🔒') : null,
          auth.mode === 'supabase' && s.approved === false ? h('span', { class: 'sl-pending', title: 'Ostatní ho uvidí, až ho admin schválí' }, 'čeká na schválení') : null),
        h('span', { class: 'sl-actions' },
          auth.admin && s.approved === false ? h('button', {
            class: 'sl-approve', title: 'Schválit – uvidí ho všichni',
            onclick: async () => {
              try { await window.KSB_SUPA.approve(s.id); s.approved = true; renderLibrary(); toast(`„${s.title}“ je schválený ✓`); }
              catch { toast('Schválení se nepovedlo, zkus to znovu.'); }
            },
          }, '✓ Schválit') : null,
          s.hasSync !== false ? h('a', { class: 'sl-link sl-link-along', href: '#along-' + s.id, title: 'Hudba, text a akordy v rytmu' }, 'Play Along') : null,
          h('a', { class: 'sl-link sl-link-chords', href: '#play-' + s.id, title: 'Jen text s akordy' }, 'Akordy'))));
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
  if (window.KSB_SUPA && songs.some(s => s.partial)) {
    toast('Připravuju zálohu…');
    try { await window.KSB_SUPA.loadAll(); } catch { toast('Zálohu se nepodařilo připravit.'); return; }
  }
  const json = JSON.stringify({ app: 'kytara-s-bobem', version: 1, songs }, null, 2);
  const filename = 'playalong-zaloha.json';
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
    } catch { toast('Tohle nevypadá jako záloha z playalong.cz'); }
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
              h('div', { style: 'font-size:13px;color:var(--muted)' }, `${secs ? `Našel jsem ${secs} částí.` : ''}`))),
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
      song.key = k; song.baseKey = null; song.capo = capo || 0;
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
    song.capo ? h('button', {
      class: 'capo-pill', title: play ? `Kapodastr na ${song.capo}. pražci` : 'Klikni pro odebrání kapodastru',
      onclick: () => { if (play) return; pushUndo(song); song.capo = 0; touch(song); renderEditor(); toast('Kapodastr odebrán', 'Zpět', undo); },
    }, `Kapo ${song.capo}`) : null,
    !play && h('button', { class: 'btn', onclick: () => openAudioModal(song), title: 'Poznat tóninu z MP3 nebo YouTube' }, ico('headphones'), 'Z nahrávky'),
    play && h('div', { class: 'tgroup', title: 'Transpozice – jen pro zobrazení, písnička se nemění' },
      h('button', { onclick: () => transpose(-1), 'aria-label': 'Transponovat dolů' }, '−'),
      h('button', {
        class: 'tr-val' + (viewShift ? ' moved' : ''),
        title: viewShift ? 'Posunuto jen pro tebe – klik vrátí originál' : 'Originální tónina',
        onclick: () => { if (viewShift) transpose(-viewShift); },
      }, stepLabel(viewShift)),
      h('button', { onclick: () => transpose(1), 'aria-label': 'Transponovat nahoru' }, '+')),
    play && capoControl(),
    play && h('div', { class: 'tgroup', title: 'Velikost písma' },
      h('button', { onclick: () => setFont(-1) }, 'A−'),
      h('button', {
        id: 'fsVal', class: 'tr-val' + (fontStep() ? ' moved' : ''),
        title: 'Velikost písma – klik vrátí výchozí', onclick: () => setFont(-fontStep()),
      }, stepLabel(fontStep())),
      h('button', { onclick: () => setFont(1) }, 'A+')),
    play && h('div', { class: 'tgroup', title: 'Automatické posouvání' },
      h('button', { class: autoscroll.on ? 'on' : '', id: 'asBtn', onclick: toggleAutoscroll }, autoscroll.on ? '❚❚ Stop' : '▶ Posouvat'),
      h('button', { onclick: () => setSpeed(-1) }, '−'),
      h('span', { id: 'asSpeed', title: 'Rychlost posouvání' }, autoscroll.speed),
      h('button', { onclick: () => setSpeed(1) }, '+')),
    !play && h('div', { class: 'tgroup history', title: 'Historie úprav' },
      h('button', { id: 'undoBtn', onclick: undo, title: 'Zpět (Ctrl+Z)', disabled: !undoStack.length }, '↶ Zpět'),
      h('button', { id: 'redoBtn', onclick: redo, title: 'Vrátit (Ctrl+Y)', disabled: !redoStack.length }, 'Vrátit ↷')),
    !play && h('button', { class: 'btn', onclick: () => openSongModal(song) }, ico('pencil'), 'Text'),
    !play && h('button', { class: 'btn', onclick: copyText, title: 'Zkopírovat jako text s akordy' }, ico('copy'), 'Kopírovat'),
    !play && auth.mode === 'supabase' && h('button', {
      class: 'btn', title: 'Smazat song',
      onclick: () => {
        const idx = songs.indexOf(song);
        songs = songs.filter(x => x !== song);
        saveSongs(); go('#');
        toast(`„${song.title}“ smazán`, 'Zpět', () => { songs.splice(Math.min(idx, songs.length), 0, song); saveSongs(); go('#song-' + song.id); });
      },
    }, ico('trash'), 'Smazat'),
    !play && auth.mode === 'supabase' && h('button', {
      class: 'btn', title: song.isPublic === false ? 'Teď ho vidíš jen ty. Klikni pro zveřejnění.' : 'Teď ho vidí všichni. Klikni a uvidíš ho jen ty.',
      onclick: () => {
        song.isPublic = song.isPublic === false;
        touch(song); renderEditor();
        toast(song.isPublic ? 'Song je veřejný' : 'Song vidíš jen ty');
      },
    }, ...(song.isPublic === false ? [ico('lock'), 'Jen pro mě'] : [ico('globe'), 'Veřejný'])),
    play && h('a', { class: 'btn al-btn', href: '#along-' + song.id, title: 'Play-along: hudba, text se přebarvuje podle zpěvu a akordy svítí' }, '🎸 Play-along'),
    play
      ? (editable ? h('a', { class: 'btn primary', href: '#song-' + song.id }, '✎ Upravit') : null)
      : h('button', {
          class: 'btn rainbow', title: 'Uložit a přepnout na hraní',
          onclick: () => { touch(song); saveSongs(true); go('#play-' + song.id); toast('Uloženo ✓'); },
        }, ico('save'), 'Uložit'));

  document.body.classList.toggle('playing', play);
  if (play) {
    // režim hraní: jedna tenká lišta, ať je co nejvíc místa na text
    controls.prepend(h('button', {
      class: 'tbtn' + (settings.cols !== false ? ' on' : ''), title: 'Text do sloupců / jeden sloupec',
      onclick: () => { settings.cols = settings.cols === false; saveSettings(); renderEditor(); },
    }, settings.cols !== false ? 'Sloupce' : 'Sloupec'));
    controls.prepend(h('button', {
      class: 'tbtn' + (settings.compact !== false ? ' on' : ''),
      title: 'Kompaktně: krátké řádky po dvou, opakování ×2, stejný refrén sbalený. Písnička se nemění.',
      onclick: () => { settings.compact = settings.compact === false; saveSettings(); renderEditor(); },
    }, 'Kompaktně'));
    ed.append(h('div', { class: 'play-bar' },
      h('a', { class: 'pb-back', href: '#', title: 'Zpět na seznam' }, '←'),
      h('div', { class: 'pb-name', title: (song.artist ? song.artist + ' – ' : '') + song.title },
        song.artist ? h('span', { class: 'pb-artist' }, song.artist + ' – ') : null,
        h('b', {}, song.title || 'Bez názvu'),
        h('span', { class: 'pb-key' }, ' · ' + keyName(viewSong(song).key) + ' / ' + keyShort(relKey(viewSong(song).key)) + (viewCapo ? ` · kapo ${viewCapo}. pražec` : ''))),
      controls));
  } else {
    ed.append(h('div', { class: 'song-head' },
      h('div', { class: 'titles' }, titleIn, artistIn,
        h('button', { class: 'key-pill', title: 'Změnit tóninu (nabídku akordů)', onclick: e => openKeyPopover(e.currentTarget) },
          h('small', {}, 'Tónina'), keyName(song.key), h('small', {}, '/ ' + keyShort(relKey(song.key)))),
        song.author && auth.mode === 'supabase' ? h('div', { class: 'by' }, 'přidal(a) ', h('b', {}, song.author)) : null),
      controls));
  }

  if (!play) ed.append(renderPalette(song));
  const sheet = h('div', { class: 'sheet' + (play && settings.cols !== false ? ' cols' : ''), id: 'sheet' });
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
      'Klik na akord v textu = změna, odtažení pryč = smazání. ', h('b', {}, 'Ctrl+Z'), ' = zpět, ', h('b', {}, 'Ctrl+Y'), ' = vrátit. Přejeď myší přes řádek, ', h('b', {}, 'Ctrl+C'), ', klikni jinam a ', h('b', {}, 'Ctrl+V'), ' = opakování akordů.'));
}
const sameChord = (a, b) => a.root === b.root && (a.q || '') === (b.q || '') && (a.bass ?? null) === (b.bass ?? null);

// =========================================================
//  KOMPAKTNÍ ZOBRAZENÍ – jen pevná pravidla, uložená písnička se nemění
// =========================================================
let expandedRefs = new Set();   // sbalené refrény, které si uživatel rozbalil
const lineSig = l => JSON.stringify([l.text.trim().toLowerCase(), l.chords.map(c => [c.pos, c.root, c.q || '', c.bass ?? null])]);

function compactPlan(song, single) {
  const L = song.lines;
  const plan = { skip: new Set(), pairWith: new Map(), repeatEnd: new Map(), collapsed: new Set(), repLines: new Set() };
  const inRepeat = new Set();
  const starts = [];
  L.forEach((l, i) => { if (i === 0 || l.section) starts.push(i); });
  const ranges = starts.map((a, k) => [a, k + 1 < starts.length ? starts[k + 1] : L.length]);

  // 1) refrén, který je úplně stejný jako první refrén → sbalit
  let firstChorus = null;
  for (const [a, b] of ranges) {
    if (L[a].section !== 'chorus') continue;
    let e = b;
    while (e > a && !L[e - 1].text && !L[e - 1].chords.length) e--;
    const sig = L.slice(a, e).map(lineSig).join('|');
    if (firstChorus === null) { firstChorus = sig; continue; }
    if (sig === firstChorus && !expandedRefs.has(a)) {
      plan.collapsed.add(a);
      for (let i = a; i < b; i++) plan.skip.add(i);
    }
  }

  // 2) stejné řádky (nebo skupiny až 4 řádků) hned po sobě → jednou s ×N
  for (const [a, b] of ranges) {
    if (plan.collapsed.has(a)) continue;
    const same = (x, y) => x < b && y < b && !!L[x].text && lineSig(L[x]) === lineSig(L[y]);
    const bestAt = s => {
      let best = null;
      for (let k = 1; k <= 4; k++) {
        let r = 1;
        for (;;) {
          let ok = true;
          for (let t = 0; t < k; t++) if (!same(s + t, s + r * k + t)) { ok = false; break; }
          if (!ok) break;
          r++;
        }
        if (r >= 2 && (!best || r * k > best.r * best.k)) best = { k, r, end: s + r * k };
      }
      return best;
    };
    let i = a;
    while (i < b) {
      if (!L[i].text) { i++; continue; }
      let best = bestAt(i);
      // když skupina začínající o kousek dál dojde dál (např. „A / B“ ×5 místo „B / A“ ×5), počkej na ni
      if (best) for (let o = 1; o < best.k; o++) { const alt = bestAt(i + o); if (alt && alt.end > best.end) { best = null; break; } }
      if (best) {
        for (let t = 0; t < best.k * best.r; t++) { inRepeat.add(i + t); if (t >= best.k) plan.skip.add(i + t); else if (best.k > 1) plan.repLines.add(i + t); }
        plan.repeatEnd.set(i + best.k - 1, best.r);
        i += best.k * best.r;
      } else i++;
    }
  }

  // 3) dva krátké řádky po sobě → vedle sebe (jen v jednom sloupci, kde je místo)
  if (single) {
    const SHORT = 30, SUM = 56;
    const ok = (x, b) => x < b && !plan.skip.has(x) && !inRepeat.has(x) && !!L[x].text && L[x].text.length <= SHORT && !L[x].chords.some(c => c.pos > L[x].text.length + 2);
    for (const [a, b] of ranges) {
      if (plan.collapsed.has(a)) continue;
      let i = a;
      while (i < b) {
        if (ok(i, b) && ok(i + 1, b) && !L[i + 1].section && L[i].text.length + L[i + 1].text.length <= SUM) {
          plan.pairWith.set(i, i + 1);
          plan.skip.add(i + 1);
          i += 2;
        } else i++;
      }
    }
  }
  return plan;
}

function renderSheet() {
  const real = current();
  const sheet = $('#sheet');
  if (!real || !sheet) return;
  const play = isPlay(real);
  const song = play ? viewSong(real) : real;   // při hraní případný posun pro zobrazení
  sheet.innerHTML = '';
  let sec = null;
  const counts = {};

  if (!song.lines.length) {
    sheet.append(h('p', { style: 'color:var(--muted)' }, 'Song je prázdný. Klikni na „✎ Text“ a vlož ho.'));
  }
  if (!play) {
    sheet.append(h('button', {
      class: 'add-top', title: 'Vloží prázdný řádek na úplný začátek – pak na něj přetáhni Intro a akordy',
      onclick: () => { insertLine(0); toast('Řádek přidán nahoru – přetáhni na něj Intro a akordy'); },
    }, '+ řádek na začátek (třeba intro)'));
  }

  // při hraní je každá část v bloku (ve sloupcích se nerozdělí); štítek části je vpravo u prvního řádku
  let block = play ? null : sheet;
  let markFirst = false;
  let pendingLabel = null;
  let blockStart = true;   // první řádek barevného pole → potřebuje nahoře místo na akordy
  const inlineLabels = play && settings.cols === false;   // jeden sloupec: štítek vpravo na řádku s textem
  let markShort = false;
  const newBlock = () => { block = h('div', { class: 'sec-block' }); sheet.append(block); };
  // kompaktní zobrazení (jen při hraní): páry krátkých řádků, ×N u opakování, sbalený opakovaný refrén
  const plan = play && settings.compact !== false ? compactPlan(song, settings.cols === false) : null;

  /** vytvoř element jednoho řádku */
  const makeLine = (line, li, extra = '') => {
    const empty = !line.text && !line.chords.length;
    const maxPos = line.chords.reduce((m, c) => Math.max(m, c.pos + 1), 0);
    let len = Math.max(line.text.length, maxPos);
    if (!play) len = line.text ? Math.max(len, line.text.length + 4)
      : line.chords.length ? len + 4                       // mezihra: za posledním akordem pár volných míst
      : innerWidth < 600 ? 14 : 28;                        // prázdný řádek: místo na první akordy
    else if (!line.text) len = Math.max(len, 1);
    const lineEl = h('div', {
      class: 'line' + (empty ? ' empty-line' : '') + (!line.text ? ' instr' : '') + extra,
      'data-li': li, 'data-s': sec || null,
    });
    const byPos = new Map(line.chords.map(c => [c.pos, c]));
    // místa před textem: v editoru vždy pár volných, při hraní jen když tam akord je
    const minPos = line.chords.reduce((m, c) => Math.min(m, c.pos), 0);
    const start = !play && line.text ? Math.min(-PRE_SLOTS, minPos) : minPos;
    if (start < 0) lineEl.style.setProperty('--pre', String(-start));
    for (let i = start; i < len; i++) {
      const ch = i >= 0 && i < line.text.length ? line.text[i] : null;
      const span = h('span', { class: 'c' + (ch == null ? ' pad' : '') + (i < 0 ? ' pre' : ''), 'data-i': i }, ch == null ? ' ' : ch);
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
        h('button', { title: 'Kopírovat akordy celého řádku', onclick: () => copyChords(li, -Infinity, Infinity, 0) }, '⧉'),
        h('button', { title: 'Vložit zkopírované akordy do tohoto řádku', onclick: () => pasteChords(li, 0) }, '📋'),
        h('button', { title: 'Vložit prázdný řádek pod (třeba pro intro/mezihru)', onclick: () => insertLine(li + 1) }, '+'),
        h('button', { title: 'Smazat řádek', onclick: () => deleteLine(li) }, '×')));
    }
    if (plan?.repeatEnd.has(li)) lineEl.append(h('span', { class: 'rep-badge', title: 'Opakuj' }, '×' + plan.repeatEnd.get(li)));
    return lineEl;
  };

  song.lines.forEach((line, li) => {
    if (line.section) {
      if (play) newBlock();
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
      markFirst = true;
      blockStart = true;
      // sbalený opakovaný refrén: jen štítek a řádek „stejný jako výše“
      if (plan?.collapsed.has(li)) {
        block.append(h('div', { class: 'collapsed-ref', 'data-s': sec, role: 'button', tabindex: 0,
          title: 'Klikni pro rozbalení',
          onclick: () => { expandedRefs.add(li); renderSheet(); },
          onkeydown: e => { if (e.key === 'Enter') { expandedRefs.add(li); renderSheet(); } },
        }, lab, h('span', { class: 'cr-text' }, 'stejný jako výše · rozbalit ▸')));
        return;
      }
      // v jednom sloupci štítek na stejný řádek jako první řádek textu (vpravo), ve sloupcích nad část
      if (inlineLabels) pendingLabel = lab;
      else block.append(h('div', { class: 'sec-head' }, lab));
      // krátká část (1 řádek) potřebuje víc výšky
      const next = song.lines.findIndex((l, j) => j > li && l.section);
      markShort = (next < 0 ? song.lines.length : next) - li <= 1;
    }
    if (plan?.skip.has(li)) return;
    if (!block) newBlock();
    const empty = !line.text && !line.chords.length;
    if (play && empty) {
      if (pendingLabel) { block.append(h('div', { class: 'sec-head' }, pendingLabel)); pendingLabel = null; }
      block.append(h('div', { class: 'gap' }));
      blockStart = true;
      return;
    }

    const partner = plan?.pairWith.get(li);
    const anyChords = line.chords.length || (partner != null && song.lines[partner].chords.length);
    const cls = (markFirst ? ' sec-first' : '') + (markFirst && markShort ? ' sec-short' : '')
      + (anyChords ? ' has-chords' : '') + (blockStart ? ' block-start' : '');
    let el = makeLine(line, li, cls + (plan?.repLines.has(li) ? ' rep-line' : ''));
    if (partner != null) {
      el = h('div', { class: 'line-pair', 'data-s': sec || null }, el, makeLine(song.lines[partner], partner, cls.replace(' sec-first', '')));
    }
    if (pendingLabel) { el.classList.add('has-label'); el.append(pendingLabel); pendingLabel = null; }
    block.append(el);
    markFirst = false;
    blockStart = false;
  });

  if (!play) {
    sheet.onclick = e => {
      if (!armed) return;
      const c = e.target.closest('.c');
      const l = e.target.closest('.line');
      if (!c || !l || e.target.closest('.chord')) return;
      placeChord(+l.dataset.li, +c.dataset.i, armed);
    };
    // kliknutí = kurzor pro vložení, tažení myší přes řádek = označení akordů
    sheet.onpointerdown = e => {
      if (armed || e.button !== 0) return;
      const c = e.target.closest('.c');
      const l = e.target.closest('.line');
      if (!c || !l || e.target.closest('.chord, .line-tools')) return;
      const li = +l.dataset.li, i = +c.dataset.i;
      if (e.shiftKey && caret && caret.li === li) { selection = { li, a: caret.pos, b: i }; paintSelection(); return; }
      selection = null; caret = { li, pos: i };
      paintSelection();
      if (e.pointerType !== 'mouse') return;      // na dotyku nechej rolování
      e.preventDefault();
      const move = ev => {
        const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.c');
        if (!el || el.closest('.line') !== l) return;
        const j = +el.dataset.i;
        if (j === i && !selection) return;
        selection = { li, a: i, b: j };
        paintSelection();
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (selection) {
          const r = selRange();
          const n = current().lines[li].chords.filter(ch => ch.pos >= r.from && ch.pos <= r.to).length;
          if (n) toast(`Označeno akordů: ${n} – Ctrl+C je zkopíruje`);
        }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  }
  paintSelection();
  updateHistoryButtons();
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
// ---------- kopírování akordů mezi řádky ----------
let selection = null;   // { li, a, b } označený úsek řádku
let caret = null;       // { li, pos } kam vložit
let chordClip = null;   // [{ d, root, q, bass }] – d = vzdálenost od začátku kopie
const selRange = () => selection && { li: selection.li, from: Math.min(selection.a, selection.b), to: Math.max(selection.a, selection.b) };

function paintSelection() {
  $$('.c.sel, .c.caret').forEach(el => el.classList.remove('sel', 'caret'));
  const r = selRange();
  if (r) $$(`.line[data-li="${r.li}"] > .c`).forEach(el => { const i = +el.dataset.i; if (i >= r.from && i <= r.to) el.classList.add('sel'); });
  if (caret && !r) $(`.line[data-li="${caret.li}"] > .c[data-i="${caret.pos}"]`)?.classList.add('caret');
}
function clearSelection() { selection = null; caret = null; paintSelection(); }

/** zkopíruj akordy z řádku li mezi pozicemi from–to; anchor = odkud se měří vzdálenost */
function copyChords(li, from, to, anchor = from) {
  const song = current();
  const cs = song.lines[li].chords.filter(c => c.pos >= from && c.pos <= to);
  if (!cs.length) { toast('Tady nejsou žádné akordy ke zkopírování'); return; }
  chordClip = cs.map(c => ({ d: c.pos - anchor, root: c.root, q: c.q || '', bass: c.bass ?? null }));
  toast(`Zkopírováno akordů: ${cs.length} – klikni do jiného řádku a dej Ctrl+V (nebo 📋)`);
}
function pasteChords(li, at) {
  if (!chordClip) { toast('Nejdřív zkopíruj akordy (označ je myší a Ctrl+C, nebo ⧉ u řádku)'); return; }
  const song = current();
  const line = song.lines[li];
  if (!line) return;
  pushUndo(song);
  for (const c of chordClip) {
    const pos = at + c.d;
    if (pos < PRE_MIN) continue;
    line.chords = line.chords.filter(x => x.pos !== pos);
    line.chords.push({ pos, root: c.root, q: c.q, bass: c.bass });
  }
  line.chords.sort((a, b) => a.pos - b.pos);
  touch(song);
  renderSheet();
  toast(`Vloženo akordů: ${chordClip.length}`, 'Zpět', undo);
}

function insertLine(at) {
  clearSelection();
  const song = current();
  pushUndo(song);
  song.lines.splice(at, 0, { text: '', chords: [], section: null });
  touch(song); renderSheet();
}
function deleteLine(li) {
  clearSelection();
  const song = current();
  pushUndo(song);
  const [removed] = song.lines.splice(li, 1);
  if (removed.section && song.lines[li] && !song.lines[li].section) song.lines[li].section = removed.section;
  touch(song); renderSheet();
  toast('Řádek smazán', 'Zpět', undo);
}
/** o kolik půltónů je song posunutý oproti původní tónině (−5 … +6) */

/* Transpozice je jen pro zobrazení: nic se neukládá a po obnovení stránky / jiné písničce je zase originál.
   (Vlastní upravené verze přijdou s osobními zpěvníky.) */
let viewShift = 0;
let viewCapo = 0;      // kapodastr pro zobrazení: akordy se ukážou jako tvary, které se s kapem hrají
function rerenderView() {
  if (route.view === 'along' && typeof alongShiftChanged === 'function') alongShiftChanged();
  else renderEditor();
}
function transpose(n) {
  viewShift += n;
  if (viewShift > 11 || viewShift < -11) viewShift %= 12;
  rerenderView();
}
// akordy, které jdou na kytaru snadno (otevřené tvary)
const EASY_CHORDS = new Set(['0:', '2:', '4:', '7:', '9:', '9:m', '4:m', '2:m', '0:7', '2:7', '4:7', '7:7', '9:7', '11:7', '9:m7', '4:m7', '2:m7', '0:maj7', '5:maj7']);
/** varianty kapodastru seřazené od nejlehčí: { capo, easy (podíl snadných akordů), key (v jaké tónině hraješ tvary) } */
function capoOptions(song) {
  const all = song.lines.flatMap(l => l.chords).map(c => ({ root: mod(c.root + viewShift), q: c.q || '' }));
  const opts = [];
  for (let capo = 0; capo <= 7; capo++) {
    const easy = all.length ? all.filter(c => EASY_CHORDS.has(mod(c.root - capo) + ':' + c.q)).length / all.length : 0;
    opts.push({ capo, easy, key: { ...song.key, root: mod(song.key.root + viewShift - capo) }, score: easy - capo * 0.02 });
  }
  return opts.sort((a, b) => b.score - a.score);
}
/** nejlepší pražec pro kapodastr: co nejvíc snadných akordů, raději nízko */
function bestCapo(song) {
  const best = capoOptions(song)[0];
  return best && best.easy > 0 ? best.capo : 0;
}
/** nabídka víc variant kapodastru */
function openCapoPicker(anchor) {
  const song = current();
  const opts = capoOptions(song).filter(o => o.capo !== 0 && o.easy >= 0.35).slice(0, 4);   // jen varianty, které opravdu pomůžou
  if (!opts.some(o => o.capo === 0)) opts.push(capoOptions(song).find(o => o.capo === 0));
  const row = o => h('button', {
    class: 'capo-opt' + (o.capo === viewCapo ? ' on' : ''),
    onclick: () => { closePopover(); setCapo(o.capo); },
  },
    h('b', {}, o.capo ? `Kapo ${o.capo}` : 'Bez kapa'),
    h('span', {}, `hraješ jako ${keyName(o.key)}`),
    h('small', {}, `${Math.round(o.easy * 100)} % snadných akordů`));
  openPopover(anchor, h('div', { class: 'capo-pick' },
    h('h5', {}, 'Kapodastr – vyber variantu'),
    ...opts.map(row)));
}
function setCapo(n) {
  viewCapo = Math.max(0, Math.min(9, n));
  rerenderView();
}
/** ovládání kapodastru (do lišty při hraní a v play-along) */
function capoControl() {
  if (!viewCapo) return h('button', { class: 'tbtn', title: 'Vyber kapodastr – nabídne varianty s nejjednoduššími akordy', onclick: e => openCapoPicker(e.currentTarget) }, 'Kapo');
  return h('div', { class: 'tgroup capo-on', title: 'Kapodastr – akordy jsou tvary, které hraješ s kapem' },
    h('button', { onclick: () => setCapo(viewCapo - 1), 'aria-label': 'O pražec níž' }, '−'),
    h('button', { class: 'tr-val moved', onclick: e => openCapoPicker(e.currentTarget), title: 'Jiná varianta / vypnout' }, `Kapo ${viewCapo}`),
    h('button', { onclick: () => setCapo(viewCapo + 1), 'aria-label': 'O pražec výš' }, '+'));
}
const viewCache = new WeakMap();
/** písnička tak, jak se má zobrazit (s posunem pro zobrazení) – NEUKLÁDAT, jen číst */
function viewSong(song) {
  const eff = viewShift - viewCapo;   // transpozice a kapodastr dohromady
  if (!song || !eff) return song;
  const c = viewCache.get(song);
  if (c && c.shift === eff && c.lines === song.lines && c.updated === song.updated) return c.v;
  const sh = ch => ({ ...ch, root: mod(ch.root + eff), bass: ch.bass == null ? ch.bass : mod(ch.bass + eff) });
  const v = {
    ...song,
    key: { ...song.key, root: mod(song.key.root + eff) },
    lines: song.lines.map(l => ({ ...l, chords: l.chords.map(sh) })),
    custom: (song.custom || []).map(sh),
  };
  viewCache.set(song, { shift: eff, lines: song.lines, updated: song.updated, v });
  return v;
}
const FONT_DEFAULT = 19;
const fontStep = () => Math.round((settings.fontSize - FONT_DEFAULT) / 2);
const stepLabel = d => d > 0 ? '+' + d : d < 0 ? '−' + (-d) : '0';
function setFont(d) {
  settings.fontSize = Math.min(33, Math.max(13, settings.fontSize + d * 2));
  saveSettings();
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  const b = $('#fsVal');
  if (b) { b.textContent = stepLabel(fontStep()); b.classList.toggle('moved', fontStep() !== 0); }
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
  if (b) { b.textContent = autoscroll.on ? '❚❚ Stop' : '▶ Posouvat'; b.classList.toggle('on', autoscroll.on); }
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
  const s = $('#asSpeed'); if (s) s.textContent = autoscroll.speed;
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
  if (!p.hidden && !p.contains(e.target) && !e.target.closest('.chord, .sec-label, .key-pill, .chip.add, .capo-btn')) closePopover();
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
        song.key = k; song.baseKey = null; touch(song);
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
  const typing = !!e.target.matches?.('input, textarea');
  if (e.key === 'Escape') {
    if (drag) { teardownDrag(); return; }
    if (!$('#popover').hidden) { closePopover(); return; }
    if ($('#modalRoot').children.length) { closeModal(); return; }
    if (armed) { armed = null; renderEditor(); return; }
    if (selection || caret) clearSelection();
  }
  const k = e.key.toLowerCase();
  const editing = route.view === 'song' && current() && !isPlay(current());
  if ((e.ctrlKey || e.metaKey) && !typing && editing && k === 'c' && selection) {
    e.preventDefault();
    const r = selRange();
    copyChords(r.li, r.from, r.to);
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !typing && editing && k === 'v' && (caret || selection)) {
    e.preventDefault();
    const at = caret || { li: selRange().li, pos: selRange().from };
    pasteChords(at.li, at.pos);
    return;
  }
  if (route.view === 'along' && !typing) {
    if (e.key === ' ') { e.preventDefault(); alToggle(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); alUndo(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); alSeek(alNow() + (e.key === 'ArrowLeft' ? -5 : 5)); }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && !typing && route.view === 'song' && (k === 'z' || k === 'y')) {
    e.preventDefault();
    if (k === 'y' || e.shiftKey) redo(); else undo();
  }
  if (e.key === ' ' && !typing && route.view === 'song' && route.mode === 'play') {
    e.preventDefault();
    toggleAutoscroll();
  }
});

// se Supabase se songy teprve načítají → odkaz na konkrétní song nesmí hned přesměrovat na seznam
if (window.KSB_SUPA) auth.loading = true;
render();
if (window.KSB_SUPA) window.KSB_SUPA.init(); else cloud.init();
