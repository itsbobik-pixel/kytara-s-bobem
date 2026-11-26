'use strict';
/* =========================================================
   playalong.cz – Video (lyrics + play-along)
   Vykreslí animované video do <canvas> podle časů v song.sync
   (stejný model jako play-along v along.js). Náhled hraje stopy
   z pomocníka, export = WebCodecs H.264 (hardwarově) → pomocník
   přidá ffmpegem zvuk: verze s vokálem i karaoke (bez vokálu).
   Víc designů = THEMES (Neon, Kino, Zpěvník, Retro 80s, Bold).
   Stránka: video.html#<id songu>   (?theme=retro pro výchozí design)
   ========================================================= */

const HELPER = location.port === '5174' ? '' : 'http://127.0.0.1:5174';
const PRE = 4;          // s – úvodní karta před začátkem písně (odpočet)
const POST = 5;         // s – závěrečná karta
const FPS = 30;
const LEAD = 0.25;      // řádek se „rozsvítí“ kousek před prvním slovem

// ---------- hudební teorie a barvy (stejné jako v appce) ----------
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const DEG = ['#FF5A5F', '#FFB020', '#7BC74D', '#2D9CDB', '#8B5CF6', '#FF6FB5', '#14B8A6'];
const DEG_INK = ['#fff', '#2A1E00', '#102A00', '#fff', '#fff', '#fff', '#fff'];
const DX = '#4A4566';
const SEC = { intro: '#FFB020', verse: '#2D9CDB', pre: '#8B5CF6', chorus: '#FF5A5F', bridge: '#7BC74D', solo: '#FF8A3D', inter: '#B07CFF', outro: '#14B8A6' };
const SEC_LABEL = { intro: 'Intro', verse: 'Sloka', pre: 'Předrefrén', chorus: 'Refrén', bridge: 'Bridge', inter: 'Mezihra', solo: 'Sólo', outro: 'Outro' };
const FONT = 'Outfit, system-ui, sans-serif';

const mod = n => ((n % 12) + 12) % 12;
const chordName = c => NOTE[mod(c.root)] + (c.q || '') + (c.bass != null ? '/' + NOTE[mod(c.bass)] : '');
const degree = (root, key) => (key.minor ? MINOR : MAJOR).indexOf(mod(root - key.root));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const ease = x => { x = clamp(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const easeOut = x => 1 - Math.pow(1 - clamp(x), 3);
const lerp = (a, b, k) => a + (b - a) * k;
const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mixHex = (a, b, k) => { const A = hex(a), B = hex(b); return '#' + A.map((v, i) => Math.round(lerp(v, B[i], clamp(k))).toString(16).padStart(2, '0')).join(''); };
const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; };
const fmtTime = s => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const seeded = seed => { let s = seed % 2147483647 || 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; };

// ---------- model časů (kopie buildModel z along.js) ----------
function buildModel(song, sync) {
  const lines = song.lines.map((line, li) => {
    const sl = sync.lines[li] || { w: [], c: [] };
    const words = sl.w.map(([pos, len, s, e], k) => ({ k, pos, len, s, e: Math.max(e, s + 0.05) }))
      .filter(w => w.pos < Math.max(1, line.text.length));
    const tAt = pos => {
      if (!words.length) return null;
      if (pos <= words[0].pos) return words[0].s;
      for (const w of words) {
        if (pos >= w.pos && pos <= w.pos + w.len) return w.s + (w.e - w.s) * Math.min(1, (pos - w.pos) / Math.max(1, w.len));
      }
      const after = words.find(w => w.pos > pos);
      return after ? after.s : words[words.length - 1].e;
    };
    const chords = line.chords.map(ch => {
      const hit = sl.c.find(c => c[0] === ch.pos);
      return { ch, pos: ch.pos, t: hit ? hit[1] : tAt(ch.pos), explicit: !!hit };
    });
    return { li, words, chords, s: words.length ? words[0].s : null, e: words.length ? words[words.length - 1].e : null };
  });
  lines.forEach((L, i) => {
    if (L.s != null || !L.chords.length) return;
    if (L.chords.every(c => c.t != null)) {
      const ts = L.chords.map(c => c.t);
      L.s = Math.min(...ts); L.e = Math.max(...ts) + 1.5;
      return;
    }
    const prev = lines.slice(0, i).reverse().find(x => x.e != null);
    const next = lines.slice(i + 1).find(x => x.s != null);
    const a = prev ? prev.e : 0, b = next ? next.s : a + 4;
    L.chords.forEach((c, k) => { if (c.t == null) c.t = a + (b - a) * (k + 0.5) / L.chords.length; });
    L.s = L.chords[0].t; L.e = b;
  });
  const chords = lines.flatMap(L => L.chords.map(c => ({ ...c, li: L.li }))).filter(c => c.t != null).sort((x, y) => x.t - y.t);
  return { lines, chords };
}

// ---------- stav ----------
const V = {
  song: null, rows: [], baseRows: [], chords: [], secEv: [], dur: 0, total: 0,
  W: 1920, H: 1080, fmt: 'land', L: null, TH: null, theme: 'neon',
  ctx: null, measure: null,
  ac: null, bufs: {}, gainV: null, srcs: [], playing: false, t0: 0, T: 0,
};

function prepare(song) {
  const key = song.key;
  const m = buildModel(song, song.sync);
  const colorOf = c => { const d = degree(c.root, key); return d < 0 ? DX : DEG[d]; };
  const inkOf = c => { const d = degree(c.root, key); return d < 0 ? '#fff' : DEG_INK[d]; };
  const verses = song.lines.filter(l => l.section === 'verse').length;
  let sec = 'verse', label = '', vn = 0, fresh = false;
  const rows = [];
  m.lines.forEach(L => {
    const line = song.lines[L.li];
    if (line.section) {
      sec = line.section; fresh = true;
      if (sec === 'verse') vn++;
      label = (SEC_LABEL[sec] || sec) + (sec === 'verse' && verses > 1 ? ' ' + vn : '');
    }
    const text = line.text || '';
    if ((!text.trim() && !line.chords.length) || L.s == null) return;
    rows.push({
      li: L.li, text, instr: !text.trim(), sec, label, secStart: fresh,
      words: L.words, s: L.s, e: L.e,
      chords: L.chords.filter(c => c.t != null).map(c => ({ pos: c.pos, t: c.t, name: chordName(c.ch), color: colorOf(c.ch), ink: inkOf(c.ch) })),
    });
    fresh = false;
  });
  // akordy v čase – stejné po sobě jdoucí sloučíme (pro „Hraje / Další“)
  const chords = [];
  m.chords.forEach(c => {
    const o = { t: c.t, name: chordName(c.ch), color: colorOf(c.ch), ink: inkOf(c.ch) };
    const last = chords[chords.length - 1];
    if (last && last.name === o.name) return;
    if (last && o.t - last.t < 0.05) { Object.assign(last, o); return; }
    chords.push(o);
  });
  const dur = Math.max(song.sync.dur || 0, (chords[chords.length - 1]?.t || 0) + 2);
  chords.forEach((c, i) => { c.end = i + 1 < chords.length ? chords[i + 1].t : dur; c.i = i; });
  const secEv = [];
  rows.forEach(r => { if (r.secStart || !secEv.length) secEv.push({ t: r.s - LEAD, sec: r.sec, label: r.label, color: SEC[r.sec] || SEC.verse }); });
  Object.assign(V, { song, chords, secEv, dur, total: PRE + dur + POST, baseRows: rows });
}

// =========================================================
//   DESIGNY
// =========================================================
const THEMES = {
  neon: {
    label: 'Neon', dark: true,
    lyric: ['600', FONT], title: ['800', FONT], ink: '#ffffff', inkA: 0.93, pastA: 0.5,
    hi: 'glow', pop: 0.07, chip: 'fill', hud: 'chips', ui: '#ffffff', card: 'grad',
    bg: (ctx, T, t) => bgNeon(ctx, T, t),
  },
  kino: {
    label: 'Kino', dark: true,
    lyric: ['400', '"DM Serif Display", Georgia, serif'], title: ['400', '"DM Serif Display", Georgia, serif'],
    ink: '#ffffff', inkA: 0.42, pastA: 0.6, hi: 'white', pop: 0.05, chip: 'text', hud: 'line', ui: '#ffffff', card: 'white',
    letterbox: true, prog: 'thin',
    lay: { land: { fs: 88, cy: 560, slots: [[-2, -330], [-1, -215], [0, 0], [1, 200], [2, 320], [3, 420]], alphas: { p1: 0.16, n1: 0.5, n2: 0 } } },
    bg: (ctx, T, t) => bgKino(ctx, T, t),
  },
  papir: {
    label: 'Zpěvník', dark: false,
    lyric: ['700', FONT], title: ['700', '"Caveat", cursive'], ink: '#1D1A2F', inkA: 1, pastA: 0.4,
    hi: 'marker', pop: 0.04, chip: 'fill', hud: 'chips', ui: '#1D1A2F', card: 'ink', hand: true,
    lay: { land: { cy: 575 } },
    bg: (ctx, T, t) => bgPaper(ctx, T, t),
  },
  retro: {
    label: 'Retro 80s', dark: true, upper: true,
    lyric: ['400', '"Bebas Neue", Impact, sans-serif'], title: ['400', '"Bebas Neue", Impact, sans-serif'],
    ink: '#ffffff', inkA: 0.95, pastA: 0.45, shadow: 'rgba(25,0,45,0.9)', hi: 'neon', hiColor: '#3DF2FF', pop: 0.09, chip: 'outline', hud: 'chips', ui: '#ffffff', card: 'chrome',
    lay: {
      land: { fs: 100, cy: 405, slots: [[-2, -290], [-1, -168], [0, 0], [1, 165], [2, 270], [3, 350]], alphas: { p1: 0.25, n1: 0.6, n2: 0.18 } },
      vert: { fs: 84, cy: 760 },
    },
    bg: (ctx, T, t) => bgRetro(ctx, T, t),
  },
  bold: {
    label: 'Bold', dark: false,
    lyric: ['400', '"Archivo Black", Impact, sans-serif'], title: ['400', '"Archivo Black", Impact, sans-serif'],
    ink: '#111111', inkA: 1, pastA: 0.32, hi: 'box', pop: 0.06, chip: 'ink', hud: 'giant', ui: '#111111', card: 'black',
    lay: {
      land: { fs: 80, align: 'left', left: 120, maxW: 1360, cy: 640, slots: [[-2, -330], [-1, -190], [0, 0], [1, 185], [2, 310], [3, 410]] },
      vert: { align: 'left', left: 70, maxW: 900, fs: 64 },
    },
    bg: (ctx, T, t) => bgBold(ctx, T, t),
  },
};

// ---------- rozvržení ----------
function layout(fmt, TH) {
  const land = fmt !== 'vert';
  const W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  const base = land ? {
    land, W, H, pad: 64, align: 'center', left: 120,
    fs: 80, maxW: 1640, cx: W / 2, cy: 560,
    slots: [[-2, -330], [-1, -190], [0, 0], [1, 195], [2, 330], [3, 445]],
    alphas: { p1: 0.3, n1: 0.62, n2: 0.28 },
    hud: { x: 64, y: 52, big: 116, mid: 84, small: 62 },
    prog: { y: H - 52 },
  } : {
    land, W, H, pad: 56, align: 'center', left: 70,
    fs: 70, maxW: 960, cx: W / 2, cy: 1030,
    slots: [[-2, -370], [-1, -210], [0, 0], [1, 220], [2, 370], [3, 500]],
    alphas: { p1: 0.3, n1: 0.62, n2: 0.28 },
    hud: { x: 56, y: 230, big: 124, mid: 88, small: 64 },
    prog: { y: H - 190 },
  };
  return { ...base, ...((TH.lay || {})[land ? 'land' : 'vert'] || {}) };
}

function setFormat(fmt, theme) {
  V.fmt = fmt || V.fmt;
  V.theme = theme || V.theme;
  V.TH = THEMES[V.theme] || THEMES.neon;
  V.L = layout(V.fmt, V.TH);
  V.W = V.L.W; V.H = V.L.H;
  const cv = document.getElementById('cv');
  cv.width = V.W; cv.height = V.H;
  V.ctx = cv.getContext('2d');
  V.measure = new Map();
  V.rows = splitRows(V.baseRows);
}

const lyricFont = size => `${V.TH.lyric[0]} ${size}px ${V.TH.lyric[1]}`;
const shown = text => V.TH.upper ? text.toLocaleUpperCase('cs') : text;

/** šířka prefixů textu při velikosti 100 px (škáluje se lineárně) */
function metrics(text) {
  let m = V.measure.get(text);
  if (m) return m;
  const ctx = V.ctx;
  ctx.font = lyricFont(100);
  const pref = [0];
  for (let i = 1; i <= text.length; i++) pref.push(ctx.measureText(text.slice(0, i)).width);
  m = { pref, w: pref[text.length], ch: ctx.measureText('a').width };
  V.measure.set(text, m);
  return m;
}
const prefX = (m, pos, len) => pos <= 0 ? pos * m.ch : pos >= len ? m.w + (pos - len) * m.ch * 0.9 : m.pref[pos];

/** dlouhé řádky rozdělí na dva podle mezery nejblíž středu */
function splitRows(rows) {
  const L = V.L, out = [];
  rows.forEach(r => {
    if (r.instr) { out.push(r); return; }
    const m = metrics(shown(r.text));
    if (m.w * L.fs / 100 <= L.maxW * 1.12 || !r.words.length) { out.push(r); return; }
    const mid = r.text.length / 2;
    let cut = -1;
    r.words.forEach(w => { if (w.pos > 0 && (cut < 0 || Math.abs(w.pos - mid) < Math.abs(cut - mid))) cut = w.pos; });
    if (cut <= 0) { out.push(r); return; }
    const part = (a, b, first) => {
      const words = r.words.filter(w => w.pos >= a && w.pos < b).map(w => ({ ...w, pos: w.pos - a }));
      const chords = r.chords.filter(c => first ? c.pos < b : c.pos >= a).map(c => ({ ...c, pos: c.pos - a }));
      return { ...r, text: r.text.slice(a, b).trimEnd(), words, chords, secStart: first && r.secStart,
        s: words.length ? words[0].s : r.s, e: words.length ? words[words.length - 1].e : r.e };
    };
    out.push(part(0, cut, true), part(cut, r.text.length, false));
  });
  return out;
}

// ---------- vyhledávání v čase ----------
function rowAt(t) {
  let i = -1;
  for (let k = 0; k < V.rows.length; k++) { if (V.rows[k].s - LEAD <= t) i = k; else break; }
  return i;
}
function chordAt(t) {
  let i = -1;
  for (let k = 0; k < V.chords.length; k++) { if (V.chords[k].t <= t + 0.03) i = k; else break; }
  return i;
}
function secAt(t) {
  let i = 0;
  for (let k = 0; k < V.secEv.length; k++) if (V.secEv[k].t <= t) i = k;
  return i;
}
function secColor(t) {
  const i = secAt(t), ev = V.secEv[i];
  if (!ev) return SEC.verse;
  if (i === 0 || t < ev.t) return ev.color;
  return mixHex(V.secEv[i - 1].color, ev.color, ease((t - ev.t) / 1.2));
}
function chordColor(t) {
  const i = chordAt(t);
  if (i < 0) return V.chords[0]?.color || DX;
  if (i === 0) return V.chords[0].color;
  return mixHex(V.chords[i - 1].color, V.chords[i].color, ease((t - V.chords[i].t) / 0.35));
}
const chordPulse = t => { const i = chordAt(t); return i >= 0 ? Math.exp(-(t - V.chords[i].t) * 3) : 0; };

// =========================================================
//   POZADÍ
// =========================================================
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }
function blob(ctx, x, y, r, c, a) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, rgba(c, a)); g.addColorStop(0.55, rgba(c, a * 0.35)); g.addColorStop(1, rgba(c, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, V.W, V.H);
}
function vignette(ctx, a, c = '5,4,12') {
  const { W, H } = V, M = Math.max(W, H);
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, M * 0.75);
  g.addColorStop(0, `rgba(${c},0)`); g.addColorStop(1, `rgba(${c},${a})`);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}
const PARTS = (() => { const rnd = seeded(7); return Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd(), r: 1.5 + rnd() * 4.5, v: 8 + rnd() * 26, a: 0.05 + rnd() * 0.18, ph: rnd() * 6.28, k: Math.floor(rnd() * 7), s: rnd() })); })();

function bgNeon(ctx, T, t) {
  const { W, H } = V, M = Math.max(W, H);
  ctx.fillStyle = '#0c0a17'; ctx.fillRect(0, 0, W, H);
  const sc = secColor(t), cc = chordColor(t), pulse = chordPulse(t);
  blob(ctx, W * (0.22 + 0.07 * Math.sin(T * 0.13)), H * (0.32 + 0.08 * Math.cos(T * 0.11)), M * 0.62, sc, 0.34);
  blob(ctx, W * (0.80 + 0.06 * Math.cos(T * 0.09)), H * (0.72 + 0.07 * Math.sin(T * 0.12)), M * 0.52, cc, 0.20 + 0.16 * pulse);
  blob(ctx, W * (0.55 + 0.1 * Math.sin(T * 0.07 + 2)), H * (0.08 + 0.05 * Math.sin(T * 0.1)), M * 0.35, mixHex(sc, '#8B5CF6', 0.5), 0.14);
  for (const p of PARTS) {
    const x = ((p.x * W + Math.sin(T * 0.3 + p.ph) * 30) % W + W) % W;
    const y = ((p.y * H - T * p.v) % H + H) % H;
    ctx.fillStyle = rgba(mixHex('#ffffff', sc, 0.4), p.a * (0.7 + 0.3 * Math.sin(T * 1.3 + p.ph)));
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, 6.283); ctx.fill();
  }
  vignette(ctx, 0.72);
}

function bgKino(ctx, T, t) {
  const { W, H } = V, M = Math.max(W, H);
  ctx.fillStyle = '#070609'; ctx.fillRect(0, 0, W, H);
  const sc = secColor(t);
  blob(ctx, W * (0.5 + 0.12 * Math.sin(T * 0.05)), H * 1.02, M * 0.7, sc, 0.26);
  blob(ctx, W * (0.5 + 0.2 * Math.cos(T * 0.04)), -H * 0.1, M * 0.5, chordColor(t), 0.07 + 0.05 * chordPulse(t));
  // filmové zrno
  const rnd = seeded(Math.floor(T * 24) * 7919 + 13);
  for (let i = 0; i < 260; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + rnd() * 0.05})`;
    ctx.fillRect(rnd() * W, rnd() * H, 2, 2);
  }
  vignette(ctx, 0.85, '0,0,0');
}

function bgPaper(ctx, T, t) {
  const { W, H } = V;
  ctx.fillStyle = '#FFFBF4'; ctx.fillRect(0, 0, W, H);
  blob(ctx, W * 0.15, H * 0.1, W * 0.5, secColor(t), 0.10);
  blob(ctx, W * 0.9, H * 0.9, W * 0.45, chordColor(t), 0.08 + 0.05 * chordPulse(t));
  // linky sešitu + okraj
  ctx.fillStyle = 'rgba(45,156,219,0.10)';
  for (let y = 40; y < H; y += 62) ctx.fillRect(0, y, W, 2);
  ctx.fillStyle = 'rgba(255,90,95,0.22)'; ctx.fillRect(V.L.land ? 96 : 44, 0, 3, H);
  // konfety v barvách stupňů
  for (const p of PARTS.slice(0, 30)) {
    const x = ((p.x * W + Math.sin(T * 0.2 + p.ph) * 40) % W + W) % W;
    const y = ((p.y * H + T * p.v * 0.6) % (H + 60) + H + 60) % (H + 60) - 30;
    ctx.save(); ctx.translate(x, y); ctx.rotate(T * 0.4 * (p.s - 0.5) + p.ph);
    ctx.fillStyle = rgba(DEG[p.k], 0.22);
    const r = 5 + p.r * 2.2;
    if (p.k % 3 === 0) { ctx.beginPath(); ctx.arc(0, 0, r * 0.7, 0, 6.283); ctx.fill(); }
    else if (p.k % 3 === 1) { rr(ctx, -r / 2, -r / 2, r, r, 3); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.lineTo(r * 0.6, r * 0.5); ctx.lineTo(-r * 0.6, r * 0.5); ctx.fill(); }
    ctx.restore();
  }
  vignette(ctx, 0.10, '120,90,40');
}

function bgRetro(ctx, T, t) {
  const { W, H } = V;
  const hz = H * 0.62;
  const sky = ctx.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#0b0020'); sky.addColorStop(0.55, '#3a0a63'); sky.addColorStop(1, '#ff3c8e');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, hz);
  // hvězdy
  for (const p of PARTS) {
    const y = p.y * hz * 0.8;
    ctx.fillStyle = `rgba(255,255,255,${p.a * 2.2 * (0.6 + 0.4 * Math.sin(T * 2 + p.ph * 3))})`;
    ctx.fillRect(p.x * W, y, p.r * 0.6, p.r * 0.6);
  }
  // slunce s pruhy
  const R = Math.min(W, H) * (V.L.land ? 0.24 : 0.2), sx = W / 2, sy = hz - R * 0.12;
  const glow = ctx.createRadialGradient(sx, sy, R * 0.6, sx, sy, R * 2.2);
  glow.addColorStop(0, 'rgba(255,90,150,0.45)'); glow.addColorStop(1, 'rgba(255,90,150,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, W, hz);
  ctx.save();
  ctx.globalAlpha = 0.78;
  ctx.beginPath(); ctx.arc(sx, sy, R, 0, 6.283); ctx.clip();
  const sg = ctx.createLinearGradient(0, sy - R, 0, sy + R);
  sg.addColorStop(0, '#ffe76a'); sg.addColorStop(0.5, '#ff8a4c'); sg.addColorStop(1, '#ff2e88');
  ctx.fillStyle = sg; ctx.fillRect(sx - R, sy - R, 2 * R, 2 * R);
  ctx.fillStyle = sky;
  for (let k = 0; k < 7; k++) {
    const y = sy + R * (0.05 + k * 0.14) + ((T * 12) % (R * 0.14));
    ctx.fillRect(sx - R, y, 2 * R, 3 + k * 2.4);
  }
  ctx.restore();
  // podlaha s mřížkou
  const fl = ctx.createLinearGradient(0, hz, 0, H);
  fl.addColorStop(0, '#2a0650'); fl.addColorStop(1, '#07001a');
  ctx.fillStyle = fl; ctx.fillRect(0, hz, W, H - hz);
  const pulse = chordPulse(t);
  ctx.strokeStyle = `rgba(255,60,200,${0.55 + 0.35 * pulse})`;
  ctx.lineWidth = 2;
  ctx.beginPath();
  const n = 16, ph = (T * 0.9) % 1;
  for (let i = 0; i < n; i++) {
    const p = (i + ph) / n, y = hz + (H - hz) * Math.pow(p, 2.3);
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  for (let i = -16; i <= 16; i++) { ctx.moveTo(W / 2 + i * W * 0.012, hz); ctx.lineTo(W / 2 + i * W * 0.13, H); }
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,60,200,0.9)'; ctx.fillRect(0, hz - 1, W, 3);
  const hg = ctx.createLinearGradient(0, hz - 40, 0, hz + 60);
  hg.addColorStop(0, 'rgba(255,60,200,0)'); hg.addColorStop(0.45, 'rgba(255,60,200,0.35)'); hg.addColorStop(1, 'rgba(255,60,200,0)');
  ctx.fillStyle = hg; ctx.fillRect(0, hz - 40, W, 100);
  // ztmavení za textem, ať je čitelný
  const tg = ctx.createLinearGradient(0, 0, 0, hz);
  tg.addColorStop(0, 'rgba(8,0,24,0.45)'); tg.addColorStop(0.75, 'rgba(8,0,24,0.25)'); tg.addColorStop(1, 'rgba(8,0,24,0)');
  ctx.fillStyle = tg; ctx.fillRect(0, 0, W, hz);
}

function bgBold(ctx, T, t) {
  const { W, H } = V;
  const sc = secColor(t);
  ctx.fillStyle = sc; ctx.fillRect(0, 0, W, H);
  // velké geometrické tvary
  const cc = chordColor(t), pulse = chordPulse(t);
  const R = H * (V.L.land ? 0.46 : 0.3) * (1 + 0.04 * pulse);
  const cx = V.L.land ? W + R * 0.08 : W * 0.95, cy = V.L.land ? H * 0.56 : H * 0.62;
  ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(cx + 18, cy + 18, R, 0, 6.283); ctx.fill();
  ctx.fillStyle = cc; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 6.283); ctx.fill();
  ctx.save(); ctx.translate(cx, cy); ctx.rotate(T * 0.15);
  ctx.strokeStyle = 'rgba(17,17,17,0.9)'; ctx.lineWidth = 6;
  ctx.beginPath(); ctx.arc(0, 0, R * 0.62, 0, 4.2); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#111'; ctx.fillRect(V.L.pad, V.L.land ? 236 : 420, V.W - V.L.pad * 2, 5);
  // jemné zrno
  const rnd = seeded(Math.floor(T * 12) * 31 + 5);
  for (let i = 0; i < 160; i++) { ctx.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`; ctx.fillRect(rnd() * W, rnd() * H, 3, 3); }
}

// =========================================================
//   PRVKY
// =========================================================
/** akord: 'fill' čip, 'outline' neonový rámeček, 'text' jen barevné písmo, 'ink' černý štítek */
function chip(ctx, x, y, h, c, opts = {}) {
  const style = opts.style || V.TH.chip;
  const fs = h * (opts.fsK || 0.62);
  ctx.font = `800 ${fs}px ${FONT}`;
  const tw = ctx.measureText(c.name).width;
  const w = style === 'text' ? tw + h * 0.2 : Math.max(h * 1.05, tw + h * 0.5);
  const sc = opts.scale || 1;
  const r = h * 0.28;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.scale(sc, sc);
  if (style === 'fill') {
    if (opts.glow) { ctx.shadowColor = c.color; ctx.shadowBlur = opts.glow; }
    ctx.fillStyle = c.color; rr(ctx, -w / 2, -h / 2, w, h, r); ctx.fill();
    ctx.shadowBlur = 0;
    if (opts.fill != null) { ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, r); ctx.clip(); ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(-w / 2, -h / 2, w * opts.fill, h); ctx.restore(); }
    if (opts.ring) { ctx.lineWidth = Math.max(3, h * 0.06); ctx.strokeStyle = V.TH.dark ? 'rgba(255,255,255,0.95)' : '#1D1A2F'; rr(ctx, -w / 2 - 1, -h / 2 - 1, w + 2, h + 2, r * 1.05); ctx.stroke(); }
    ctx.fillStyle = c.ink;
  } else if (style === 'outline') {
    const lc = mixHex(c.color, '#ffffff', 0.25);
    ctx.fillStyle = opts.ring ? rgba(c.color, 0.35) : 'rgba(10,0,30,0.55)';
    rr(ctx, -w / 2, -h / 2, w, h, r * 0.6); ctx.fill();
    if (opts.fill != null) { ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, r * 0.6); ctx.clip(); ctx.fillStyle = rgba(c.color, 0.3); ctx.fillRect(-w / 2, -h / 2, w * opts.fill, h); ctx.restore(); }
    ctx.shadowColor = c.color; ctx.shadowBlur = opts.glow ? opts.glow : 10;
    ctx.lineWidth = Math.max(2.5, h * (opts.ring ? 0.07 : 0.045)); ctx.strokeStyle = lc;
    rr(ctx, -w / 2, -h / 2, w, h, r * 0.6); ctx.stroke();
    ctx.fillStyle = opts.ring ? '#ffffff' : lc;
  } else if (style === 'ink') {
    ctx.fillStyle = opts.ring ? c.color : '#111111';
    rr(ctx, -w / 2, -h / 2, w, h, h * 0.12); ctx.fill();
    if (opts.ring) { ctx.lineWidth = Math.max(3, h * 0.07); ctx.strokeStyle = '#111'; ctx.stroke(); }
    if (opts.fill != null) { ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, h * 0.12); ctx.clip(); ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(-w / 2, -h / 2, w * opts.fill, h); ctx.restore(); }
    ctx.fillStyle = opts.ring ? c.ink : mixHex(c.color, '#ffffff', 0.15);
  } else {   // text
    const lc = mixHex(c.color, '#ffffff', 0.3);
    if (opts.glow) { ctx.shadowColor = c.color; ctx.shadowBlur = opts.glow; }
    ctx.fillStyle = lc;
    if (opts.ring) { ctx.fillRect(-tw / 2, h * 0.42, tw, Math.max(3, h * 0.07)); }
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.name, 0, h * 0.04);
  ctx.restore();
  return w;
}
function chipW(ctx, h, name, fsK = 0.62) {
  ctx.font = `800 ${h * fsK}px ${FONT}`;
  const tw = ctx.measureText(name).width;
  return V.TH.chip === 'text' ? tw + h * 0.2 : Math.max(h * 1.05, tw + h * 0.5);
}

function slot(d) {
  const S = V.L.slots;
  if (d <= S[0][0]) return S[0][1] + (d - S[0][0]) * 120;
  for (let i = 1; i < S.length; i++) if (d <= S[i][0]) return lerp(S[i - 1][1], S[i][1], (d - S[i - 1][0]) / (S[i][0] - S[i - 1][0]));
  return S[S.length - 1][1] + (d - S[S.length - 1][0]) * 110;
}
const scaleAt = d => d >= 0 ? lerp(1, 0.6, clamp(d)) - 0.08 * clamp(d - 1, 0, 2) : lerp(1, 0.6, clamp(-d)) - 0.1 * clamp(-d - 1);
function alphaAt(d) {
  const A = V.L.alphas;
  if (d >= 0) return d <= 1 ? lerp(1, A.n1, d) : d <= 2 ? lerp(A.n1, A.n2, d - 1) : lerp(A.n2, 0, d - 2);
  return d >= -1 ? lerp(1, A.p1, -d) : lerp(A.p1, 0, -d - 1);
}

function drawLyrics(ctx, t, alpha) {
  const L = V.L, rows = V.rows;
  const i = rowAt(t);
  let scroll = -1;
  if (i >= 0) scroll = i - 1 + ease((t - (rows[i].s - LEAD)) / 0.55);
  const ci = chordAt(t);
  const curChord = ci >= 0 ? V.chords[ci] : null;
  const sc = secColor(t);
  for (let k = Math.max(0, Math.floor(scroll) - 2); k < Math.min(rows.length, Math.floor(scroll) + 5); k++) {
    const d = k - scroll;
    if (d < -2.3 || d > 3.6) continue;
    const a = alphaAt(d) * alpha;
    if (a <= 0.01) continue;
    drawRow(ctx, rows[k], L.cy + slot(d), scaleAt(d), a, t, k === i, curChord, sc);
  }
  // odpočet před dalším řádkem po delší pauze
  const nx = rows[i + 1];
  if (nx && (i < 0 || t > rows[i].e + 1.2)) {
    const left = nx.s - t;
    if (left > 0 && left < 3.2 && (i < 0 || nx.s - rows[i].e > 3)) {
      const d = i + 1 - scroll;
      const y = L.cy + slot(d) - L.fs * scaleAt(d) * 2.25;
      const x = L.align === 'left' ? L.left + 34 : L.cx;
      for (let n = 0; n < 3; n++) {
        const on = left <= 3 - n;
        ctx.fillStyle = on ? rgba(V.TH.dark ? mixHex(sc, '#ffffff', 0.3) : '#1D1A2F', alpha) : rgba(V.TH.dark ? '#ffffff' : '#1D1A2F', 0.18 * alpha);
        ctx.beginPath(); ctx.arc(x + (n - 1) * 34, y, on ? 9 : 7, 0, 6.283); ctx.fill();
      }
    }
  }
}

function drawRow(ctx, r, y, scale, a, t, isCur, curChord, sc) {
  const L = V.L, TH = V.TH;
  ctx.save();
  ctx.globalAlpha = a;
  if (r.instr) { drawInstrRow(ctx, r, y, scale, t, curChord); ctx.restore(); return; }
  const text = shown(r.text);
  const m = metrics(text);
  const fit = Math.min(L.fs, L.fs * L.maxW / (m.w * L.fs / 100));
  const fs = fit * scale, k = fs / 100;
  const tw = m.w * k;
  const x0 = L.align === 'left' ? L.left : L.cx - tw / 2;
  const base = y + fs * 0.34;
  const X = pos => x0 + prefX(m, pos, text.length) * k;
  // akordy nad textem
  const chH = Math.max(26, fs * 0.62);
  const chY = y - fs * 0.62 - chH - fs * 0.14;
  let right = -1e9;
  for (const c of [...r.chords].sort((p, q) => p.pos - q.pos)) {
    const w = chipW(ctx, chH, c.name, 0.64);
    let x = X(c.pos) - chH * 0.12;
    if (x < right + 6) x = right + 6;
    right = x + w;
    const now = curChord && Math.abs(curChord.t - c.t) < 0.06 && curChord.name === c.name;
    const done = c.t <= t && !now;
    const pulse = now ? 1 + 0.16 * Math.exp(-(t - c.t) * 7) : 1;
    ctx.globalAlpha = a * (now ? 1 : done ? 0.42 : isCur ? 0.95 : 0.85);
    chip(ctx, x, chY, chH, c, { fsK: 0.64, scale: pulse, glow: now ? 26 * scale : 0, ring: now });
  }
  ctx.globalAlpha = a;
  ctx.font = lyricFont(fs);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  const clipX = (xa, xb, fn) => { ctx.save(); ctx.beginPath(); ctx.rect(xa, y - fs * 1.5, xb - xa, fs * 3); ctx.clip(); fn(); ctx.restore(); };
  const ink = TH.ink;
  if (TH.shadow) { ctx.shadowColor = TH.shadow; ctx.shadowBlur = fs * 0.18; ctx.shadowOffsetY = fs * 0.04; }
  if (!isCur) { ctx.fillStyle = rgba(ink, TH.inkA); ctx.fillText(text, x0, base); ctx.restore(); return; }

  // aktuální řádek: zvýrazněné je jen právě zpívané slovo
  let cw = null, pastEnd = x0 - 2;
  for (const w of r.words) {
    if (t < w.s - 0.04) break;
    if (t <= w.e + 0.12) cw = w; else pastEnd = X(w.pos + w.len);
  }
  if (cw) pastEnd = X(cw.pos);
  const BIG = 1e5;
  ctx.fillStyle = rgba(ink, TH.inkA * TH.pastA);
  clipX(x0 - 200, pastEnd, () => ctx.fillText(text, x0, base));
  ctx.fillStyle = rgba(ink, TH.inkA);
  if (cw) {
    const xa = X(cw.pos), xb = X(cw.pos + cw.len);
    clipX(xb, BIG, () => ctx.fillText(text, x0, base));
    drawWord(ctx, text.slice(cw.pos, cw.pos + cw.len), xa, xb, base, fs, cw, t, sc);
  } else {
    clipX(pastEnd, BIG, () => ctx.fillText(text, x0, base));
  }
  ctx.restore();
}

/** právě zpívané slovo – každý design jinak */
function drawWord(ctx, word, xa, xb, base, fs, w, t, sc) {
  const TH = V.TH;
  const inK = clamp((t - w.s + 0.04) / 0.1), outK = 1 - clamp((t - w.e) / 0.12);
  const on = Math.min(inK, outK);
  const p = clamp((t - w.s) / Math.max(0.08, w.e - w.s));
  const pop = 1 + TH.pop * easeOut(on);
  const cx = (xa + xb) / 2, ww = xb - xa;
  ctx.save();
  ctx.shadowOffsetY = 0;
  ctx.translate(cx, base - fs * 0.3);
  ctx.scale(pop, pop);
  ctx.translate(-cx, -(base - fs * 0.3));
  if (TH.hi === 'marker') {   // zvýrazňovač za slovem, táhne se během zpěvu
    ctx.fillStyle = rgba(sc, 0.42 * on);
    rr(ctx, xa - fs * 0.08, base - fs * 0.74, (ww + fs * 0.16) * Math.max(0.15, p), fs * 0.92, fs * 0.16); ctx.fill();
    ctx.fillStyle = TH.ink;
  } else if (TH.hi === 'box') {
    ctx.fillStyle = `rgba(17,17,17,${on})`;
    rr(ctx, xa - fs * 0.12, base - fs * 0.86, ww + fs * 0.24, fs * 1.1, fs * 0.08); ctx.fill();
    ctx.fillStyle = mixHex('#111111', '#ffffff', on);
  } else if (TH.hi === 'neon') {
    const c = TH.hiColor;
    ctx.shadowColor = c; ctx.shadowBlur = 40 * on;
    ctx.fillStyle = mixHex('#ffffff', c, on);
    ctx.fillText(word, xa, base);
    ctx.shadowBlur = 14 * on;
    ctx.fillStyle = mixHex('#ffffff', mixHex(c, '#ffffff', 0.55), on);
  } else if (TH.hi === 'white') {
    ctx.shadowColor = sc; ctx.shadowBlur = 34 * on;
    ctx.fillStyle = `rgba(255,255,255,${lerp(TH.inkA, 1, on)})`;
  } else {   // glow
    const hi = mixHex(sc, '#ffffff', 0.28);
    ctx.shadowColor = sc; ctx.shadowBlur = 30 * on;
    ctx.fillStyle = mixHex('#ffffff', hi, on);
  }
  ctx.fillText(word, xa, base);
  ctx.restore();
}

/** řádek bez textu (mezihra, intro, outro) = velké akordy v řadě */
function drawInstrRow(ctx, r, y, scale, t, curChord) {
  const L = V.L;
  const h = L.fs * (V.TH.chip === 'text' ? 1.25 : 1.1) * scale, gap = h * 0.32;
  const ws = r.chords.map(c => chipW(ctx, h, c.name, 0.6));
  const total = ws.reduce((s, w) => s + w, 0) + gap * (ws.length - 1);
  let x = L.align === 'left' ? L.left : L.cx - total / 2;
  const a0 = ctx.globalAlpha;
  r.chords.forEach((c, n) => {
    const tl = V.chords.find(x => Math.abs(x.t - c.t) < 0.06);
    const end = tl ? tl.end : (r.chords[n + 1]?.t ?? r.e);
    const now = curChord && Math.abs(curChord.t - c.t) < 0.06;
    const done = t >= end - 0.02;
    const pulse = now ? 1 + 0.12 * Math.exp(-(t - c.t) * 7) : 1;
    ctx.globalAlpha = a0 * (now ? 1 : done ? 0.38 : 0.9);
    chip(ctx, x, y - h / 2, h, c, { fsK: 0.6, scale: pulse, glow: now ? 34 * scale : 0, ring: now, fill: now ? clamp((t - c.t) / (end - c.t)) : null });
    x += ws[n] + gap;
  });
  ctx.globalAlpha = a0;
}

function label(ctx, text, x, y, size, align = 'left', a = 0.6) {
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = rgba(V.TH.ui, a);
  if ('letterSpacing' in ctx) ctx.letterSpacing = size * 0.14 + 'px';
  ctx.fillText(text.toUpperCase(), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}
const fmtLeft = s => 'za ' + Math.max(0, s).toFixed(1).replace('.', ',') + ' s';

// ---------- Hraje / Další / Potom ----------
function drawHud(ctx, t, alpha) {
  const st = V.TH.hud;
  if (st === 'line') return hudLine(ctx, t, alpha);
  if (st === 'giant') return hudGiant(ctx, t, alpha);
  const L = V.L, Hd = L.hud, ch = V.chords;
  const i = chordAt(t);
  const cur = i >= 0 ? ch[i] : null, next = ch[i + 1], then = ch[i + 2];
  ctx.save();
  ctx.globalAlpha = alpha;
  let x = Hd.x;
  const y = Hd.y;
  label(ctx, 'Hraje', x, y + 22, 22);
  const cy = y + 38;
  if (cur) {
    const pulse = 1 + 0.14 * Math.exp(-(t - cur.t) * 8);
    const w = chip(ctx, x, cy, Hd.big, cur, { scale: pulse, glow: 40, fill: clamp((t - cur.t) / (cur.end - cur.t)) });
    x += Math.max(w, Hd.big * 1.3) + 40;
  } else {
    ctx.fillStyle = rgba(V.TH.ui, 0.12); rr(ctx, x, cy, Hd.big * 1.3, Hd.big, Hd.big * 0.28); ctx.fill();
    x += Hd.big * 1.3 + 40;
  }
  if (next) {
    const a = cur ? cur.t : -PRE, b = next.t, left = b - t;
    label(ctx, 'Další', x, y + 22, 22);
    const nw = chipW(ctx, Hd.mid, next.name);
    const ny = cy + (Hd.big - Hd.mid) / 2 - 8;
    const soon = left < 1 ? 1 + 0.06 * Math.sin(t * 18) * (1 - Math.max(0, left)) : 1;
    chip(ctx, x, ny, Hd.mid, next, { scale: soon });
    const bw = Math.max(nw, 170), by = ny + Hd.mid + 14;
    ctx.fillStyle = rgba(V.TH.ui, 0.14); rr(ctx, x, by, bw, 10, 5); ctx.fill();
    const p = clamp((t - a) / Math.max(0.1, b - a));
    ctx.fillStyle = next.color; rr(ctx, x, by, Math.max(10, bw * (1 - p)), 10, 5); ctx.fill();
    ctx.font = `700 26px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = rgba(V.TH.ui, 0.85);
    ctx.fillText(fmtLeft(left), x + nw + 18, ny + Hd.mid * 0.62);
    x += Math.max(bw, nw + 150) + 34;
    if (then && L.land) {
      label(ctx, 'Potom', x, y + 22, 22, 'left', 0.4);
      ctx.globalAlpha = alpha * 0.55;
      chip(ctx, x, cy + (Hd.big - Hd.small) / 2 - 8, Hd.small, then);
    }
  }
  ctx.restore();
}

/** Kino: jeden řádek dole v černém pruhu */
function hudLine(ctx, t, alpha) {
  const { W, H } = V, ch = V.chords, i = chordAt(t);
  const cur = i >= 0 ? ch[i] : null, next = ch[i + 1];
  const y = H - H * 0.1 / 2 - 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textBaseline = 'middle';
  const parts = [];
  ctx.font = `700 20px ${FONT}`;
  const lab = s => { ctx.font = `700 20px ${FONT}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '4px'; const w = ctx.measureText(s).width; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; return w; };
  const curName = cur ? cur.name : '–';
  ctx.font = `800 52px ${FONT}`; const cwid = ctx.measureText(curName).width;
  const nextName = next ? next.name : '';
  ctx.font = `800 38px ${FONT}`; const nwid = ctx.measureText(nextName).width;
  const total = lab('HRAJE') + 16 + cwid + 60 + lab('DALŠÍ') + 16 + nwid + 20 + 110;
  let x = W / 2 - total / 2;
  label(ctx, 'Hraje', x, y + 7, 20, 'left', 0.5); x += lab('HRAJE') + 16;
  if (cur) {
    const pulse = 1 + 0.12 * Math.exp(-(t - cur.t) * 8);
    ctx.save(); ctx.translate(x + cwid / 2, y); ctx.scale(pulse, pulse);
    ctx.font = `800 52px ${FONT}`; ctx.textAlign = 'center'; ctx.fillStyle = mixHex(cur.color, '#ffffff', 0.2);
    ctx.shadowColor = cur.color; ctx.shadowBlur = 24; ctx.fillText(curName, 0, 2); ctx.restore();
  }
  x += cwid + 60;
  if (next) {
    label(ctx, 'Další', x, y + 7, 20, 'left', 0.5); x += lab('DALŠÍ') + 16;
    ctx.font = `800 38px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = mixHex(next.color, '#ffffff', 0.3);
    ctx.fillText(nextName, x, y + 2); x += nwid + 20;
    const a = cur ? cur.t : -PRE, p = clamp((t - a) / Math.max(0.1, next.t - a));
    ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(x, y + 14, 100, 4);
    ctx.fillStyle = next.color; ctx.fillRect(x, y + 14, 100 * (1 - p), 4);
    ctx.font = `600 22px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fillText(fmtLeft(next.t - t), x, y - 6);
  }
  ctx.restore();
}

/** Bold: obří akord vlevo nahoře */
function hudGiant(ctx, t, alpha) {
  const L = V.L, ch = V.chords, i = chordAt(t);
  const cur = i >= 0 ? ch[i] : null, next = ch[i + 1], then = ch[i + 2];
  const x = L.pad, y = L.land ? 40 : 230;
  ctx.save();
  ctx.globalAlpha = alpha;
  label(ctx, 'Hraje', x, y + 22, 22, 'left', 0.75);
  const name = cur ? cur.name : '–';
  const pulse = cur ? 1 + 0.1 * Math.exp(-(t - cur.t) * 8) : 1;
  ctx.font = `400 150px "Archivo Black", ${FONT}`;
  const w = ctx.measureText(name).width;
  ctx.save(); ctx.translate(x, y + 172); ctx.scale(pulse, pulse);
  if (cur) { ctx.fillStyle = cur.color; ctx.fillRect(0, -30, 26, 26); ctx.strokeStyle = '#111'; ctx.lineWidth = 4; ctx.strokeRect(0, -30, 26, 26); }
  ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(name, cur ? 44 : 0, 0);
  ctx.restore();
  let nx = x + Math.max(260, w + 110);
  if (next) {
    label(ctx, 'Další', nx, y + 22, 22, 'left', 0.75);
    ctx.font = `400 82px "Archivo Black", ${FONT}`; ctx.fillStyle = '#111'; ctx.textAlign = 'left';
    ctx.fillText(next.name, nx, y + 130);
    const nw = Math.max(200, ctx.measureText(next.name).width);
    const a = cur ? cur.t : -PRE, p = clamp((t - a) / Math.max(0.1, next.t - a));
    ctx.fillStyle = 'rgba(17,17,17,0.2)'; ctx.fillRect(nx, y + 150, nw, 10);
    ctx.fillStyle = '#111'; ctx.fillRect(nx, y + 150, nw * (1 - p), 10);
    ctx.font = `700 26px ${FONT}`; ctx.fillText(fmtLeft(next.t - t), nx, y + 192);
    nx += nw + 70;
    if (then && L.land) {
      label(ctx, 'Potom', nx, y + 22, 22, 'left', 0.5);
      ctx.font = `400 54px "Archivo Black", ${FONT}`; ctx.fillStyle = 'rgba(17,17,17,0.55)';
      ctx.fillText(then.name, nx, y + 110);
    }
  }
  ctx.restore();
}

/** interpret, název, část, tónina */
function drawTitle(ctx, t, alpha) {
  const L = V.L, s = V.song, TH = V.TH;
  const ev = V.secEv[secAt(t)];
  ctx.save();
  ctx.globalAlpha = alpha;
  const keyTxt = 'Tónina ' + NOTE[s.key.root] + (s.key.minor ? 'm' : '') + (s.capo ? ' · kapo ' + s.capo : '');
  if (TH.letterbox) {   // Kino: v horním pruhu
    const y = V.H * 0.05;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = `400 34px ${TH.title[1]}`; ctx.fillStyle = '#fff';
    ctx.fillText(s.title || '', L.pad, y + 2);
    const tw = ctx.measureText(s.title || '').width;
    ctx.font = `500 24px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText((s.artist || '') + '   ·   ' + keyTxt, L.pad + tw + 24, y + 4);
    if (ev) {
      ctx.textAlign = 'right'; ctx.font = `700 22px ${FONT}`; ctx.fillStyle = mixHex(ev.color, '#ffffff', 0.25);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '5px';
      ctx.fillText(ev.label.toUpperCase(), V.W - L.pad, y + 2);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    ctx.restore();
    return;
  }
  const right = L.land ? L.W - L.pad : L.W / 2;
  const align = L.land ? 'right' : 'center';
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.font = `500 26px ${FONT}`; ctx.fillStyle = rgba(TH.ui, 0.66);
  ctx.fillText(s.artist || '', right, L.land ? 76 : 70);
  ctx.font = `${TH.title[0]} ${TH.hand ? 54 : 42}px ${TH.title[1]}`; ctx.fillStyle = TH.ui;
  ctx.fillText(TH.upper ? (s.title || '').toLocaleUpperCase('cs') : s.title || '', right, L.land ? 124 : 120);
  if (ev && t > -0.5) {
    const k = easeOut((t - ev.t) / 0.5);
    const txt = ev.label, h = 44;
    ctx.font = TH.hand ? `700 34px "Caveat", cursive` : `700 26px ${FONT}`;
    const w = ctx.measureText(txt).width + 36;
    ctx.font = `600 22px ${FONT}`;
    const kw = ctx.measureText(keyTxt).width + 30;
    const y = L.land ? 150 : 146;
    const xs = L.land ? right - w : right - (w + kw + 12) / 2;
    ctx.save();
    ctx.translate(xs + w / 2, y + h / 2); ctx.scale(lerp(0.7, 1, k), lerp(0.7, 1, k));
    ctx.globalAlpha = alpha * k;
    ctx.fillStyle = TH.hud === 'giant' ? '#111' : ev.color;
    if (TH.dark) { ctx.shadowColor = ev.color; ctx.shadowBlur = 20; }
    rr(ctx, -w / 2, -h / 2, w, h, TH.hud === 'giant' ? 4 : 22); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = TH.hand ? `700 34px "Caveat", cursive` : `700 26px ${FONT}`;
    ctx.fillText(txt, 0, 2);
    ctx.restore();
    const kx = L.land ? right - w - 12 - kw : xs + w + 12;
    ctx.fillStyle = rgba(TH.ui, 0.1); rr(ctx, kx, y + 4, kw, h - 8, 18); ctx.fill();
    ctx.fillStyle = rgba(TH.ui, 0.75); ctx.font = `600 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(keyTxt, kx + kw / 2, y + h / 2 + 1);
  }
  ctx.restore();
}

/** úplně dole: průběh písně, barevně po částech */
function drawProgress(ctx, t, alpha) {
  const L = V.L, TH = V.TH, x0 = L.pad, w = L.W - L.pad * 2;
  const thin = TH.prog === 'thin';
  const y = thin ? V.H - 8 : L.prog.y, hh = thin ? 3 : 6;
  ctx.save();
  ctx.globalAlpha = alpha;
  const X = s => x0 + w * clamp(s / V.dur);
  V.secEv.forEach((ev, n) => {
    const a = Math.max(0, ev.t), b = V.secEv[n + 1] ? V.secEv[n + 1].t : V.dur;
    const col = TH.hud === 'giant' ? '#111111' : ev.color;
    ctx.fillStyle = rgba(col, TH.hud === 'giant' ? 0.18 : 0.3); ctx.fillRect(X(a), y, Math.max(0, X(b) - X(a) - 3), hh);
    if (t > a) { ctx.fillStyle = col; ctx.fillRect(X(a), y, Math.max(0, Math.min(X(t), X(b) - 3) - X(a)), hh); }
  });
  if (!thin) {
    ctx.fillStyle = TH.dark ? '#fff' : '#111'; ctx.beginPath(); ctx.arc(X(t), y + 3, 8, 0, 6.283); ctx.fill();
    ctx.font = `600 20px ${FONT}`; ctx.fillStyle = rgba(TH.ui, 0.55); ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.fillText(fmtTime(t), x0, y + 34);
    ctx.textAlign = 'right'; ctx.fillText(fmtTime(V.dur), x0 + w, y + 34);
    ctx.textAlign = 'center'; ctx.fillStyle = rgba(TH.ui, 0.45); ctx.font = `700 20px ${FONT}`;
    ctx.fillText('playalong.cz', L.W / 2, y + 34);
  }
  ctx.restore();
}

/** úvodní a závěrečná karta */
function drawCard(ctx, t, a, end) {
  if (a <= 0.01) return;
  const L = V.L, s = V.song, TH = V.TH;
  ctx.save();
  ctx.globalAlpha = a;
  const cx = L.align === 'left' ? L.left : L.cx;
  const y = (TH.lay?.land?.cy && L.land ? L.cy : L.cy) - (L.land ? 40 : 60);
  const lift = (1 - a) * 30;
  ctx.textAlign = L.align === 'left' ? 'left' : 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${L.land ? 44 : 40}px ${FONT}`; ctx.fillStyle = rgba(TH.ui, 0.7);
  ctx.fillText(s.artist || '', cx, y - 90 - lift);
  const title = TH.upper ? (s.title || '').toLocaleUpperCase('cs') : s.title || '';
  const big = (L.land ? 124 : 104) * (TH.hand ? 1.4 : TH.upper ? 1.3 : 1);
  ctx.font = `${TH.title[0]} ${big}px ${TH.title[1]}`;
  const tw = ctx.measureText(title).width;
  if (TH.card === 'grad' || TH.card === 'chrome') {
    const tg = ctx.createLinearGradient(0, y - big * 0.8, 0, y + 30);
    if (TH.card === 'chrome') { tg.addColorStop(0, '#3DF2FF'); tg.addColorStop(0.5, '#ffffff'); tg.addColorStop(0.52, '#FF3CC7'); tg.addColorStop(1, '#ffb86b'); }
    const hg = ctx.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0);
    hg.addColorStop(0, '#FF5A5F'); hg.addColorStop(0.35, '#FFB020'); hg.addColorStop(0.7, '#FF6FB5'); hg.addColorStop(1, '#8B5CF6');
    ctx.fillStyle = TH.card === 'chrome' ? tg : hg;
    ctx.shadowColor = TH.card === 'chrome' ? '#FF3CC7' : 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 30;
  } else {
    ctx.fillStyle = TH.card === 'white' ? '#fff' : TH.card === 'black' ? '#111' : TH.ui;
  }
  ctx.fillText(title, cx, y + 30 - lift);
  ctx.shadowBlur = 0;
  if (TH.card === 'ink') {   // podtržení fixou
    ctx.strokeStyle = rgba(secColor(Math.max(0, t)), 0.7); ctx.lineWidth = 10; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - tw / 2, y + 60 - lift); ctx.quadraticCurveTo(cx, y + 48 - lift, cx + tw / 2, y + 62 - lift); ctx.stroke();
  }
  ctx.font = `600 34px ${FONT}`; ctx.fillStyle = rgba(TH.ui, 0.8);
  if (end) ctx.fillText('Díky za hraní!  ·  playalong.cz', cx, y + 120 - lift);
  else {
    ctx.fillText('Tónina ' + NOTE[s.key.root] + (s.key.minor ? 'm' : '') + (s.capo ? '  ·  kapo ' + s.capo : '') + '  ·  play-along', cx, y + 120 - lift);
    const left = -t;
    if (left <= 3.2 && left > 0) {
      const n = Math.ceil(left - 0.2);
      if (n >= 1 && n <= 3) {
        const f = 1 - (left - 0.2 - (n - 1));
        ctx.font = `800 ${90 + 20 * (1 - f)}px ${FONT}`;
        ctx.fillStyle = rgba(TH.ui, 0.85 * (1 - f * 0.6));
        ctx.fillText(String(n), cx, y + 260);
      }
    }
  }
  ctx.restore();
}

function letterbox(ctx) {
  const h = V.H * 0.1;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, V.W, h); ctx.fillRect(0, V.H - h, V.W, h);
}

/** jeden snímek videa v čase T (0 … V.total) */
function draw(T) {
  const ctx = V.ctx, TH = V.TH;
  const t = T - PRE;
  TH.bg(ctx, T, t);
  const intro = clamp((-t - 0.35) / 0.6);
  const outro = clamp((t - V.dur - 0.3) / 1.0);
  const main = (1 - intro) * (1 - outro);
  drawCard(ctx, t, intro, false);
  drawCard(ctx, t, outro, true);
  drawLyrics(ctx, t, main);
  if (TH.letterbox) letterbox(ctx);
  drawHud(ctx, t, Math.max(0.35, 1 - outro));
  drawTitle(ctx, t, main * clamp((t + 0.6) / 0.6));
  drawProgress(ctx, t, 1 - outro * 0.6);
}
window.renderAt = T => draw(T);

// =========================================================
//   NÁHLED (Web Audio, stopy z pomocníka)
// =========================================================
const $ = id => document.getElementById(id);
const msg = html => { $('msg').innerHTML = html; };

async function loadAudio(id) {
  try {
    const st = await (await fetch(`${HELPER}/stems/${id}/`)).json();
    if (!st['no_vocals.mp3']) { msg('Pomocník nemá stopy pro tuhle písničku – náhled bez zvuku.'); return; }
    V.ac = new AudioContext();
    const dec = async f => V.ac.decodeAudioData(await (await fetch(`${HELPER}/stems/${id}/${f}`)).arrayBuffer());
    V.bufs.inst = await dec('no_vocals.mp3');
    if (st['vocals.mp3']) V.bufs.voc = await dec('vocals.mp3');
    msg('Zvuk načtený. Mezerník = přehrát / pauza.');
  } catch (e) {
    msg('Pomocník neběží – náhled je bez zvuku a export nepůjde. Spusť <b>spustit-pomocnika.bat</b>.');
  }
}
const nowT = () => V.playing ? (V.ac ? V.ac.currentTime - V.t0 : performance.now() / 1000 - V.ac0) : V.T;
function stopSrc() { V.srcs.forEach(s => { try { s.stop(); } catch { /* už stojí */ } }); V.srcs = []; }
function play() {
  if (V.playing) { V.T = nowT(); V.playing = false; stopSrc(); $('play').textContent = '▶'; return; }
  if (V.T >= V.total - 0.1) V.T = 0;
  if (V.ac) {
    V.ac.resume();
    const now = V.ac.currentTime + 0.05, ts = V.T - PRE;
    V.gainV = V.ac.createGain(); V.gainV.gain.value = +$('voc').value; V.gainV.connect(V.ac.destination);
    for (const [k, b] of Object.entries(V.bufs)) {
      const src = V.ac.createBufferSource(); src.buffer = b;
      src.connect(k === 'voc' ? V.gainV : V.ac.destination);
      if (ts < b.duration) src.start(now + Math.max(0, -ts), Math.max(0, ts));
      V.srcs.push(src);
    }
    V.t0 = now - V.T;
  } else {
    V.ac0 = performance.now() / 1000 - V.T;
  }
  V.playing = true; $('play').textContent = '❚❚';
}
function seek(T) { const was = V.playing; if (was) play(); V.T = T; if (was) play(); }
function loop() {
  requestAnimationFrame(loop);
  if (V.exporting || !V.song) return;
  let T = nowT();
  if (T >= V.total) { T = V.total; if (V.playing) play(); V.T = T; }
  draw(T);
  $('time').textContent = fmtTime(T - PRE) + ' / ' + fmtTime(V.dur);
  if (document.activeElement !== $('seek')) $('seek').value = T;
}

// =========================================================
//   EXPORT MP4
// =========================================================
const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
const slug = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'video';

/** opts: { from, to } v sekundách videa (výchozí celé), { suffix } do názvu souboru */
async function exportMp4(opts = {}) {
  if (V.exporting) return;
  if (!('VideoEncoder' in window)) { msg('Tenhle prohlížeč neumí WebCodecs – použij Chrome nebo Edge.'); return; }
  try { await fetch(`${HELPER}/health`); } catch { msg('Pomocník neběží – spusť <b>spustit-pomocnika.bat</b>.'); return; }
  if (V.playing) play();
  const id = V.song.id, W = V.W, H = V.H;
  const from = Math.max(0, opts.from || 0), to = Math.min(V.total, opts.to || V.total);
  const name = slug(`${V.song.artist} ${V.song.title}`) + '-' + V.theme + (V.fmt === 'vert' ? '-9x16' : '') + (opts.suffix || '');
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: 9_000_000, framerate: FPS, avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) cfg = { ...cfg, hardwareAcceleration: 'no-preference' };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) { msg('Kodér H.264 tu není k dispozici.'); return; }
  V.exporting = true;
  $('export').disabled = true; $('prog').hidden = false;
  const bar = $('prog').firstElementChild;
  let parts = [], bytes = 0, err = null, sent = 0;
  const enc = new VideoEncoder({
    output: chunk => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); parts.push(b); bytes += b.length; },
    error: e => { err = e; },
  });
  enc.configure(cfg);
  const send = async () => {
    if (!parts.length) return;
    const blob = new Blob(parts); parts = []; bytes = 0;
    const r = await fetch(`${HELPER}/video/${id}/chunk?n=${sent++}`, { method: 'POST', body: blob });
    if (!r.ok) throw new Error('Pomocník nepřijal data videa.');
  };
  const f0 = Math.round(from * FPS), frames = Math.ceil(to * FPS) - f0;
  const started = performance.now();
  try {
    await fetch(`${HELPER}/video/${id}/chunk?n=reset`, { method: 'POST', body: '' });
    for (let n = 0; n < frames; n++) {
      if (err) throw err;
      draw((f0 + n) / FPS);
      const vf = new VideoFrame($('cv'), { timestamp: Math.round(n * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: n % (FPS * 2) === 0 });
      vf.close();
      while (enc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 2));
      if (bytes > 8e6) await send();
      if (n % 15 === 0) {
        const el = (performance.now() - started) / 1000, p = (n + 1) / frames;
        bar.style.width = (p * 100).toFixed(1) + '%';
        msg(`Renderuju video… <b>${Math.round(p * 100)} %</b> (snímek ${n + 1}/${frames}, ${(n / Math.max(0.1, el)).toFixed(0)} snímků/s, zbývá ~${Math.round(el / p - el)} s)`);
        await yieldNow();
      }
    }
    await enc.flush();
    await send();
    enc.close();
    msg('Přidávám zvuk (s vokálem i bez)…');
    const q = `fps=${FPS}&pre=${PRE}&start=${(f0 / FPS).toFixed(3)}&dur=${(frames / FPS).toFixed(3)}&name=${encodeURIComponent(name)}`;
    const r = await fetch(`${HELPER}/video/${id}/finish?${q}`, { method: 'POST', body: '' });
    const res = await r.json();
    if (!r.ok) throw new Error(res.error || 'Spojení se zvukem se nepovedlo.');
    V.lastExport = res;
    msg('✓ Hotovo za ' + Math.round((performance.now() - started) / 1000) + ' s: ' + res.files.map(f => `<b>${f}</b>`).join(', ') + ' (složka helper/tmp/video/' + id + '/)');
  } catch (e) {
    msg('Export se nepovedl: ' + (e.message || e));
    V.lastExport = { error: String(e.message || e) };
    try { enc.close(); } catch { /* už zavřený */ }
  } finally {
    V.exporting = false;
    $('export').disabled = false;
  }
  return V.lastExport;
}
window.exportMp4 = exportMp4;

// =========================================================
//   START
// =========================================================
async function fetchSong(id) {
  const local = (() => { try { return JSON.parse(localStorage.getItem('ksb.songs.v1') || '[]'); } catch { return []; } })();
  const hit = local.find(s => s.id === id && s.sync && s.lines);
  if (hit) return hit;
  const C = window.KSB_CONFIG;
  const r = await fetch(`${C.supabaseUrl}/rest/v1/songs?id=eq.${encodeURIComponent(id)}&select=id,title,artist,data`, { headers: { apikey: C.supabaseKey, Authorization: 'Bearer ' + C.supabaseKey } });
  const row = (await r.json())[0];
  if (!row) throw new Error('Písnička nenalezena (možná není veřejná).');
  return { id: row.id, title: row.title, artist: row.artist, ...row.data };
}

async function loadFonts() {
  const sample = 'ÁČĎÉĚÍŇÓŘŠŤÚŮÝŽáčďéěíňóřšťúůýž Ab1';
  const list = ['500 40px Outfit', '600 40px Outfit', '700 40px Outfit', '800 40px Outfit',
    '400 40px "DM Serif Display"', '700 40px Caveat', '400 40px "Bebas Neue"', '400 40px "Archivo Black"'];
  await Promise.all(list.map(f => document.fonts.load(f, sample).catch(() => null)));
}

async function init() {
  const id = (location.hash.match(/[A-Za-z0-9]{4,40}/) || [])[0];
  if (!id) { msg('Chybí ID písničky v adrese (video.html#ID).'); return; }
  const sel = $('theme');
  Object.entries(THEMES).forEach(([k, th]) => sel.append(new Option(th.label, k)));
  const want = new URLSearchParams(location.search).get('theme');
  if (want && THEMES[want]) sel.value = want;
  try {
    const song = await fetchSong(id);
    if (!song.sync) { msg('Tahle písnička ještě nemá časy – video z ní nejde udělat.'); return; }
    await loadFonts();
    prepare(song);
    setFormat($('fmt').value, sel.value);
    $('name').textContent = (song.artist ? song.artist + ' – ' : '') + song.title;
    document.title = 'Video – ' + song.title;
    $('seek').max = V.total;
    $('play').disabled = false;
    loadAudio(id);
  } catch (e) { msg('Nepovedlo se načíst písničku: ' + e.message); return; }
  $('play').onclick = play;
  $('seek').oninput = e => seek(+e.target.value);
  $('voc').oninput = e => { if (V.gainV) V.gainV.gain.value = +e.target.value; };
  $('fmt').onchange = e => setFormat(e.target.value);
  sel.onchange = e => setFormat(null, e.target.value);
  $('export').onclick = () => exportMp4();
  addEventListener('keydown', e => {
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); play(); }
    if (e.key === 'ArrowRight') seek(Math.min(V.total, nowT() + 5));
    if (e.key === 'ArrowLeft') seek(Math.max(0, nowT() - 5));
  });
  V.ready = true;
  requestAnimationFrame(loop);
}
init();
