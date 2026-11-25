'use strict';
/* =========================================================
   playalong.cz – Video (lyrics + play-along)
   Vykreslí animované video do <canvas> podle časů v song.sync
   (stejný model jako play-along v along.js). Náhled hraje stopy
   z pomocníka, export = WebCodecs H.264 (hardwarově) → pomocník
   přidá ffmpegem zvuk: verze s vokálem i karaoke (bez vokálu).
   Stránka: video.html#<id songu>
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

// ---------- příprava dat pro video ----------
const V = {
  song: null, rows: [], chords: [], secEv: [], dur: 0, total: 0,
  W: 1920, H: 1080, fmt: 'land', L: null,
  ctx: null, measure: null, parts: null,
  // náhled
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
  // akordy na časové ose – stejné po sobě jdoucí sloučíme (pro „Hraje / Další“ a pás dole)
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
  // události změny části (pro barvy pozadí a štítek)
  const secEv = [];
  rows.forEach(r => { if (r.secStart || !secEv.length) secEv.push({ t: r.s - LEAD, sec: r.sec, label: r.label, color: SEC[r.sec] || SEC.verse }); });
  Object.assign(V, { song, rows, chords, secEv, dur, total: PRE + dur + POST, baseRows: rows });
}

// ---------- rozvržení ----------
function layout(fmt) {
  const land = fmt !== 'vert';
  const W = land ? 1920 : 1080, H = land ? 1080 : 1920;
  return land ? {
    land, W, H, pad: 64,
    fs: 80, maxW: 1640, cx: W / 2, cy: 530,
    slots: [[-2, -320], [-1, -185], [0, 0], [1, 190], [2, 300], [3, 380]],
    hud: { x: 64, y: 52, big: 116, mid: 84, small: 62 },
    strip: { y: H - 168, h: 72, now: 300, pps: 165 },
    prog: { y: H - 52 },
  } : {
    land, W, H, pad: 56,
    fs: 70, maxW: 960, cx: W / 2, cy: 1010,
    slots: [[-2, -360], [-1, -205], [0, 0], [1, 215], [2, 360], [3, 485]],
    hud: { x: 56, y: 230, big: 124, mid: 88, small: 64 },
    strip: { y: H - 330, h: 80, now: 210, pps: 140 },
    prog: { y: H - 190 },
  };
}

function setFormat(fmt) {
  V.fmt = fmt;
  V.L = layout(fmt);
  V.W = V.L.W; V.H = V.L.H;
  const cv = document.getElementById('cv');
  cv.width = V.W; cv.height = V.H;
  V.ctx = cv.getContext('2d');
  V.measure = new Map();
  V.rows = splitRows(V.baseRows);
}

/** šířka prefixů textu při velikosti 100 px (škáluje se lineárně) */
function metrics(text) {
  let m = V.measure.get(text);
  if (m) return m;
  const ctx = V.ctx;
  ctx.font = `600 100px ${FONT}`;
  const pref = [0];
  for (let i = 1; i <= text.length; i++) pref.push(ctx.measureText(text.slice(0, i)).width);
  m = { pref, w: pref[text.length], ch: ctx.measureText('a').width };
  V.measure.set(text, m);
  return m;
}
const prefX = (m, pos, len) => pos <= 0 ? pos * m.ch : pos >= len ? m.w + (pos - len) * m.ch * 0.9 : m.pref[pos];

/** dlouhé řádky (hlavně na výšku) rozdělí na dva podle mezery nejblíž středu */
function splitRows(rows) {
  const L = V.L, out = [];
  rows.forEach(r => {
    if (r.instr) { out.push(r); return; }
    const m = metrics(r.text);
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
/** barva části s plynulým přechodem */
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

// ---------- kreslení ----------
function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

/** náhodná, ale pořád stejná čísla (pro částice) */
const PARTS = (() => { let s = 7; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647; return Array.from({ length: 70 }, () => ({ x: rnd(), y: rnd(), r: 1.5 + rnd() * 4.5, v: 8 + rnd() * 26, a: 0.05 + rnd() * 0.18, ph: rnd() * 6.28 })); })();

function drawBg(ctx, T, t) {
  const { W, H } = V;
  ctx.fillStyle = '#0c0a17';
  ctx.fillRect(0, 0, W, H);
  const sc = secColor(t), cc = chordColor(t);
  const ci = chordAt(t);
  const pulse = ci >= 0 ? Math.exp(-(t - V.chords[ci].t) * 3) : 0;
  const blob = (x, y, r, c, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(c, a)); g.addColorStop(0.55, rgba(c, a * 0.35)); g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  const M = Math.max(W, H);
  blob(W * (0.22 + 0.07 * Math.sin(T * 0.13)), H * (0.32 + 0.08 * Math.cos(T * 0.11)), M * 0.62, sc, 0.34);
  blob(W * (0.80 + 0.06 * Math.cos(T * 0.09)), H * (0.72 + 0.07 * Math.sin(T * 0.12)), M * 0.52, cc, 0.20 + 0.16 * pulse);
  blob(W * (0.55 + 0.1 * Math.sin(T * 0.07 + 2)), H * (0.08 + 0.05 * Math.sin(T * 0.1)), M * 0.35, mixHex(sc, '#8B5CF6', 0.5), 0.14);
  // částice
  for (const p of PARTS) {
    const x = ((p.x * W + Math.sin(T * 0.3 + p.ph) * 30) % W + W) % W;
    const y = ((p.y * H - T * p.v) % H + H) % H;
    ctx.fillStyle = rgba(mixHex('#ffffff', sc, 0.4), p.a * (0.7 + 0.3 * Math.sin(T * 1.3 + p.ph)));
    ctx.beginPath(); ctx.arc(x, y, p.r, 0, 6.283); ctx.fill();
  }
  // vinětace
  const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, M * 0.75);
  g.addColorStop(0, 'rgba(5,4,12,0)'); g.addColorStop(1, 'rgba(5,4,12,0.72)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
}

/** čipy akordu (jako v appce) */
function chip(ctx, x, y, h, c, opts = {}) {
  const fs = h * (opts.fsK || 0.62);
  ctx.font = `800 ${fs}px ${FONT}`;
  const w = Math.max(h * 1.05, ctx.measureText(c.name).width + h * 0.5);
  const sc = opts.scale || 1;
  ctx.save();
  ctx.translate(x + (opts.center ? 0 : w / 2), y + h / 2);
  ctx.scale(sc, sc);
  if (opts.glow) { ctx.shadowColor = c.color; ctx.shadowBlur = opts.glow; }
  ctx.fillStyle = c.color;
  rr(ctx, -w / 2, -h / 2, w, h, h * 0.28); ctx.fill();
  ctx.shadowBlur = 0;
  if (opts.fill != null) {   // průběh (jak dlouho akord ještě hraje)
    ctx.save(); rr(ctx, -w / 2, -h / 2, w, h, h * 0.28); ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(-w / 2, -h / 2, w * opts.fill, h);
    ctx.restore();
  }
  if (opts.ring) { ctx.lineWidth = Math.max(3, h * 0.06); ctx.strokeStyle = 'rgba(255,255,255,0.95)'; rr(ctx, -w / 2 - 1, -h / 2 - 1, w + 2, h + 2, h * 0.3); ctx.stroke(); }
  ctx.fillStyle = c.ink;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(c.name, 0, h * 0.04);
  ctx.restore();
  return w;
}
function chipW(ctx, h, name, fsK = 0.62) { ctx.font = `800 ${h * fsK}px ${FONT}`; return Math.max(h * 1.05, ctx.measureText(name).width + h * 0.5); }

function slot(d) {
  const S = V.L.slots;
  if (d <= S[0][0]) return S[0][1] + (d - S[0][0]) * 120;
  for (let i = 1; i < S.length; i++) if (d <= S[i][0]) return lerp(S[i - 1][1], S[i][1], (d - S[i - 1][0]) / (S[i][0] - S[i - 1][0]));
  return S[S.length - 1][1] + (d - S[S.length - 1][0]) * 110;
}
const scaleAt = d => d >= 0 ? lerp(1, 0.6, clamp(d)) - 0.08 * clamp(d - 1, 0, 2) : lerp(1, 0.6, clamp(-d)) - 0.1 * clamp(-d - 1);
const alphaAt = d => d >= 0 ? (d <= 1 ? lerp(1, 0.62, d) : d <= 2 ? lerp(0.62, 0.26, d - 1) : lerp(0.26, 0, d - 2)) : (d >= -1 ? lerp(1, 0.3, -d) : lerp(0.3, 0, -d - 1));

function drawLyrics(ctx, t, alpha) {
  const L = V.L, rows = V.rows;
  const i = rowAt(t);
  // plynulé posouvání: nový řádek „přijede“ do středu
  let scroll = -1;
  if (i >= 0) scroll = i - 1 + ease((t - (rows[i].s - LEAD)) / 0.55);
  else if (rows.length) scroll = -1 + 0 * t;
  const ci = chordAt(t);
  const curChord = ci >= 0 ? V.chords[ci] : null;
  const sc = secColor(t);
  for (let k = Math.max(0, Math.floor(scroll) - 2); k < Math.min(rows.length, Math.floor(scroll) + 5); k++) {
    const d = k - scroll;
    if (d < -2.3 || d > 3.6) continue;
    const a = alphaAt(d) * alpha;
    if (a <= 0.01) continue;
    drawRow(ctx, rows[k], L.cy + slot(d), scaleAt(d), a, t, k === i, k < i, curChord, sc);
  }
  // odpočet před dalším řádkem po delší pauze
  const nx = rows[i + 1];
  if (nx && (i < 0 || t > rows[i].e + 1.2)) {
    const left = nx.s - t;
    if (left > 0 && left < 3.2 && (i < 0 || nx.s - rows[i].e > 3)) {
      const d = i + 1 - scroll;
      const y = L.cy + slot(d) - L.fs * scaleAt(d) * 2.25;
      for (let n = 0; n < 3; n++) {
        const on = left <= 3 - n;
        ctx.fillStyle = on ? rgba(mixHex(sc, '#ffffff', 0.3), alpha) : rgba('#ffffff', 0.18 * alpha);
        ctx.beginPath(); ctx.arc(L.cx + (n - 1) * 34, y, on ? 9 : 7, 0, 6.283); ctx.fill();
      }
    }
  }
}

function drawRow(ctx, r, y, scale, a, t, isCur, isPast, curChord, sc) {
  const L = V.L;
  ctx.save();
  ctx.globalAlpha = a;
  if (r.instr) { drawInstrRow(ctx, r, y, scale, t, isCur, curChord); ctx.restore(); return; }
  const m = metrics(r.text);
  const fit = Math.min(L.fs, L.fs * L.maxW / (m.w * L.fs / 100));
  const fs = fit * scale, k = fs / 100;
  const tw = m.w * k;
  const x0 = L.cx - tw / 2;
  const base = y + fs * 0.34;
  // akordy nad textem
  const chH = Math.max(26, fs * 0.66);
  const chY = y - fs * 0.62 - chH - fs * 0.12;
  let right = -1e9;
  for (const c of [...r.chords].sort((p, q) => p.pos - q.pos)) {
    const w = chipW(ctx, chH, c.name, 0.64);
    let x = x0 + prefX(m, c.pos, r.text.length) * k - chH * 0.12;
    if (x < right + 6) x = right + 6;
    right = x + w;
    const now = curChord && Math.abs(curChord.t - c.t) < 0.06 && curChord.name === c.name;
    const done = c.t <= t && !now;
    const pulse = now ? 1 + 0.16 * Math.exp(-(t - c.t) * 7) : 1;
    ctx.globalAlpha = a * (now ? 1 : done ? 0.42 : isCur ? 0.95 : 0.85);
    chip(ctx, x, chY, chH, c, { fsK: 0.64, scale: pulse, glow: now ? 26 * scale : 0, ring: now });
  }
  ctx.globalAlpha = a;
  // text: nezazpívaná část bíle, zazpívaná barevně se září
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  let wx = isPast ? x0 + tw + 10 : x0 - 2;
  let edge = null;
  if (isCur) {
    for (const w of r.words) {
      if (t < w.s) break;
      const p = clamp((t - w.s) / Math.max(0.08, w.e - w.s));
      const xa = x0 + prefX(m, w.pos, r.text.length) * k, xb = x0 + prefX(m, w.pos + w.len, r.text.length) * k;
      wx = xa + (xb - xa) * p;
      edge = p < 1 ? wx : null;
    }
  }
  const hi = mixHex(sc, '#ffffff', 0.28);
  ctx.fillStyle = isPast ? hi : 'rgba(255,255,255,0.93)';
  if (!isPast && wx > x0) { ctx.save(); ctx.beginPath(); ctx.rect(wx, y - fs * 1.4, tw + 4000, fs * 2.8); ctx.clip(); ctx.fillText(r.text, x0, base); ctx.restore(); }
  else if (!isPast) ctx.fillText(r.text, x0, base);
  if (isPast || wx > x0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(x0 - 40, y - fs * 1.4, wx - x0 + 40, fs * 2.8); ctx.clip();
    ctx.fillStyle = hi;
    if (isCur) { ctx.shadowColor = sc; ctx.shadowBlur = 28 * scale; }
    ctx.fillText(r.text, x0, base);
    ctx.restore();
  }
  // jemná záře na čele zpěvu
  if (edge != null) {
    const g = ctx.createRadialGradient(edge, y, 0, edge, y, fs * 0.9);
    g.addColorStop(0, rgba(hi, 0.35)); g.addColorStop(1, rgba(hi, 0));
    ctx.fillStyle = g; ctx.fillRect(edge - fs, y - fs, fs * 2, fs * 2);
  }
  // podtržení postupu řádku
  if (isCur && r.words.length) {
    const p = clamp((wx - x0) / tw);
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    rr(ctx, x0, base + fs * 0.28, tw, Math.max(3, fs * 0.05), 3); ctx.fill();
    ctx.fillStyle = hi;
    rr(ctx, x0, base + fs * 0.28, tw * p, Math.max(3, fs * 0.05), 3); ctx.fill();
  }
  ctx.restore();
}

/** řádek bez textu (mezihra, intro, outro) = velké akordy v řadě */
function drawInstrRow(ctx, r, y, scale, t, isCur, curChord) {
  const L = V.L;
  const h = L.fs * 1.12 * scale, gap = h * 0.32;
  const ws = r.chords.map(c => chipW(ctx, h, c.name, 0.6));
  const total = ws.reduce((s, w) => s + w, 0) + gap * (ws.length - 1);
  let x = L.cx - total / 2;
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
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = size * 0.14 + 'px';
  ctx.fillText(text.toUpperCase(), x, y);
  if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
}

/** vlevo nahoře: Hraje / Další (+ za kolik) / Potom */
function drawHud(ctx, t, alpha) {
  const L = V.L, Hd = L.hud, ch = V.chords;
  const i = chordAt(t);
  const cur = i >= 0 ? ch[i] : null, next = ch[i + 1], then = ch[i + 2];
  ctx.save();
  ctx.globalAlpha = alpha;
  let x = Hd.x;
  const y = Hd.y;
  // Hraje
  label(ctx, 'Hraje', x, y + 22, 22);
  const cy = y + 38;
  if (cur) {
    const pulse = 1 + 0.14 * Math.exp(-(t - cur.t) * 8);
    const w = chip(ctx, x, cy, Hd.big, cur, { scale: pulse, glow: 40, fill: clamp((t - cur.t) / (cur.end - cur.t)) });
    x += Math.max(w, Hd.big * 1.3) + 40;
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; rr(ctx, x, cy, Hd.big * 1.3, Hd.big, Hd.big * 0.28); ctx.fill();
    x += Hd.big * 1.3 + 40;
  }
  // Další + odpočet
  if (next) {
    const a = cur ? cur.t : -PRE, b = next.t;
    const left = Math.max(0, b - t);
    label(ctx, 'Další', x, y + 22, 22);
    const nw = chipW(ctx, Hd.mid, next.name);
    const ny = cy + (Hd.big - Hd.mid) / 2 - 8;
    const soon = left < 1 ? 1 + 0.06 * Math.sin(t * 18) * (1 - left) : 1;
    chip(ctx, x, ny, Hd.mid, next, { scale: soon });
    // ubývající pruh
    const bw = Math.max(nw, 170), by = ny + Hd.mid + 14;
    ctx.fillStyle = 'rgba(255,255,255,0.14)'; rr(ctx, x, by, bw, 10, 5); ctx.fill();
    const p = clamp((t - a) / Math.max(0.1, b - a));
    ctx.fillStyle = next.color; rr(ctx, x, by, Math.max(10, bw * (1 - p)), 10, 5); ctx.fill();
    ctx.font = `700 26px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('za ' + left.toFixed(1).replace('.', ',') + ' s', x + nw + 18, ny + Hd.mid * 0.62);
    x += Math.max(bw, nw + 150) + 34;
    // Potom
    if (then && L.land) {
      label(ctx, 'Potom', x, y + 22, 22, 'left', 0.4);
      ctx.globalAlpha = alpha * 0.55;
      chip(ctx, x, cy + (Hd.big - Hd.small) / 2 - 8, Hd.small, then);
    }
  }
  ctx.restore();
}

/** vpravo nahoře (na výšku nahoře uprostřed): interpret, název, část, tónina */
function drawTitle(ctx, t, alpha) {
  const L = V.L, s = V.song;
  const ev = V.secEv[secAt(t)];
  ctx.save();
  ctx.globalAlpha = alpha;
  const right = L.land ? L.W - L.pad : L.W / 2;
  const align = L.land ? 'right' : 'center';
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
  ctx.font = `500 26px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.fillText(s.artist || '', right, L.land ? 76 : 70);
  ctx.font = `800 42px ${FONT}`; ctx.fillStyle = '#fff';
  ctx.fillText(s.title || '', right, L.land ? 124 : 120);
  // štítek části (při změně krátce „pulzne“)
  if (ev && t > -0.5) {
    const k = easeOut((t - ev.t) / 0.5);
    ctx.font = `700 26px ${FONT}`;
    const txt = ev.label;
    const w = ctx.measureText(txt).width + 36, h = 44;
    const keyTxt = 'Tónina ' + NOTE[s.key.root] + (s.key.minor ? 'm' : '') + (s.capo ? ' · kapo ' + s.capo : '');
    ctx.font = `600 22px ${FONT}`;
    const kw = ctx.measureText(keyTxt).width + 30;
    const y = L.land ? 150 : 146;
    let xs = L.land ? right - w : right - (w + kw + 12) / 2;
    ctx.save();
    ctx.translate(xs + w / 2, y + h / 2); ctx.scale(lerp(0.7, 1, k), lerp(0.7, 1, k));
    ctx.globalAlpha = alpha * k;
    ctx.fillStyle = ev.color; ctx.shadowColor = ev.color; ctx.shadowBlur = 20;
    rr(ctx, -w / 2, -h / 2, w, h, 22); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `700 26px ${FONT}`;
    ctx.fillText(txt, 0, 2);
    ctx.restore();
    const kx = L.land ? right - w - 12 - kw : xs + w + 12;
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; rr(ctx, kx, y + 4, kw, h - 8, 18); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = `600 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(keyTxt, kx + kw / 2, y + h / 2 + 1);
  }
  ctx.restore();
}

/** pás dole: akordy připlouvají k čáře „teď“ – vidíš, za jak dlouho přijdou */
function drawStrip(ctx, t, alpha) {
  const L = V.L, S = L.strip, W = L.W;
  const i = chordAt(t);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  rr(ctx, L.pad, S.y - 10, W - L.pad * 2, S.h + 20, 18); ctx.fill();
  ctx.beginPath(); ctx.rect(L.pad, S.y - 10, W - L.pad * 2, S.h + 20); ctx.clip();
  // značky po sekundách
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let s = Math.ceil(t - S.now / S.pps); s < t + W / S.pps; s++) {
    const x = S.now + (s - t) * S.pps;
    ctx.fillRect(x, S.y + S.h + 2, 2, 6);
  }
  V.chords.forEach((c, n) => {
    const x1 = S.now + (c.t - t) * S.pps, x2 = S.now + (c.end - t) * S.pps - 6;
    if (x2 < L.pad || x1 > W) return;
    const now = n === i;
    let a = now ? 1 : x1 > S.now ? 0.92 : 0.28;
    a *= clamp((W - L.pad - x1) / 260 + 0.15);
    ctx.globalAlpha = alpha * a;
    ctx.fillStyle = c.color;
    if (now) { ctx.shadowColor = c.color; ctx.shadowBlur = 24; }
    rr(ctx, x1, S.y, Math.max(8, x2 - x1), S.h, 14); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = `800 ${S.h * 0.52}px ${FONT}`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(c.name).width;
    let tx = x1 + 16;
    if (now) tx = Math.min(Math.max(tx, S.now + 14), x2 - tw - 14);   // název „drží“ u čáry
    if (x2 - x1 > tw + 20) { ctx.fillStyle = c.ink; ctx.fillText(c.name, tx, S.y + S.h / 2 + 2); }
  });
  ctx.restore();
  // čára „teď“
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#fff'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 16;
  ctx.fillRect(S.now - 2, S.y - 20, 4, S.h + 40);
  ctx.beginPath(); ctx.moveTo(S.now - 11, S.y - 24); ctx.lineTo(S.now + 11, S.y - 24); ctx.lineTo(S.now, S.y - 10); ctx.fill();
  ctx.restore();
}

/** úplně dole: průběh písně, barevně po částech */
function drawProgress(ctx, t, alpha) {
  const L = V.L, y = L.prog.y, x0 = L.pad, w = L.W - L.pad * 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  const X = s => x0 + w * clamp(s / V.dur);
  V.secEv.forEach((ev, n) => {
    const a = Math.max(0, ev.t), b = V.secEv[n + 1] ? V.secEv[n + 1].t : V.dur;
    ctx.fillStyle = rgba(ev.color, 0.3); ctx.fillRect(X(a), y, Math.max(0, X(b) - X(a) - 3), 6);
    if (t > a) { ctx.fillStyle = ev.color; ctx.fillRect(X(a), y, Math.max(0, Math.min(X(t), X(b) - 3) - X(a)), 6); }
  });
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(X(t), y + 3, 8, 0, 6.283); ctx.fill();
  ctx.font = `600 20px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left'; ctx.fillText(fmtTime(t), x0, y + 34);
  ctx.textAlign = 'right'; ctx.fillText(fmtTime(V.dur), x0 + w, y + 34);
  ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.font = `700 20px ${FONT}`;
  ctx.fillText('playalong.cz', L.W / 2, y + 34);
  ctx.restore();
}

/** úvodní a závěrečná karta */
function drawCard(ctx, t, a, end) {
  if (a <= 0.01) return;
  const L = V.L, s = V.song;
  ctx.save();
  ctx.globalAlpha = a;
  const y = L.cy - (L.land ? 40 : 60);
  const lift = (1 - a) * 30;
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `500 ${L.land ? 44 : 40}px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText(s.artist || '', L.cx, y - 90 - lift);
  ctx.font = `800 ${L.land ? 124 : 104}px ${FONT}`;
  const tg = ctx.createLinearGradient(L.cx - 500, 0, L.cx + 500, 0);
  tg.addColorStop(0, '#FF5A5F'); tg.addColorStop(0.35, '#FFB020'); tg.addColorStop(0.7, '#FF6FB5'); tg.addColorStop(1, '#8B5CF6');
  ctx.fillStyle = tg; ctx.shadowColor = 'rgba(0,0,0,0.4)'; ctx.shadowBlur = 30;
  ctx.fillText(s.title || '', L.cx, y + 30 - lift);
  ctx.shadowBlur = 0;
  ctx.font = `600 34px ${FONT}`; ctx.fillStyle = 'rgba(255,255,255,0.8)';
  if (end) ctx.fillText('Díky za hraní!  ·  playalong.cz', L.cx, y + 120 - lift);
  else {
    const keyTxt = 'Tónina ' + NOTE[s.key.root] + (s.key.minor ? 'm' : '') + (s.capo ? '  ·  kapo ' + s.capo : '') + '  ·  play-along';
    ctx.fillText(keyTxt, L.cx, y + 120 - lift);
    // odpočet 3-2-1
    const left = -t;
    if (left <= 3.2 && left > 0) {
      const n = Math.ceil(left - 0.2);
      if (n >= 1 && n <= 3) {
        const f = 1 - (left - 0.2 - (n - 1));
        ctx.font = `800 ${90 + 20 * (1 - f)}px ${FONT}`;
        ctx.fillStyle = rgba('#ffffff', 0.85 * (1 - f * 0.6));
        ctx.fillText(String(n), L.cx, y + 260);
      }
    }
  }
  ctx.restore();
}

/** jeden snímek videa v čase T (0 … V.total) */
function draw(T) {
  const ctx = V.ctx;
  const t = T - PRE;
  drawBg(ctx, T, t);
  const intro = clamp((-t - 0.35) / 0.6);          // úvodní karta mizí těsně před začátkem
  const outro = clamp((t - V.dur - 0.3) / 1.0);    // závěr
  const main = (1 - intro) * (1 - outro);
  drawCard(ctx, t, intro, false);
  drawCard(ctx, t, outro, true);
  drawLyrics(ctx, t, main);
  drawHud(ctx, t, Math.max(0.35, 1 - outro));
  drawTitle(ctx, t, main * clamp((t + 0.6) / 0.6));
  drawStrip(ctx, t, 1 - outro);
  drawProgress(ctx, t, 1 - outro * 0.6);
}
window.renderAt = T => draw(T);

// ---------- náhled (Web Audio, stopy z pomocníka) ----------
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
const nowT = () => V.playing ? V.ac.currentTime - V.t0 : V.T;
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
  let T = V.playing ? (V.ac ? nowT() : performance.now() / 1000 - V.ac0) : V.T;
  if (T >= V.total) { T = V.total; if (V.playing) play(); V.T = T; }
  draw(T);
  $('time').textContent = fmtTime(T - PRE) + ' / ' + fmtTime(V.dur);
  if (document.activeElement !== $('seek')) $('seek').value = T;
}

// ---------- export MP4 ----------
/** rychlé „uvolnění“ smyčky – nezpomaluje se ani ve skryté záložce (na rozdíl od setTimeout) */
const yieldNow = () => new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
const slug = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'video';

async function exportMp4() {
  if (V.exporting) return;
  if (!('VideoEncoder' in window)) { msg('Tenhle prohlížeč neumí WebCodecs – použij Chrome nebo Edge.'); return; }
  try { await fetch(`${HELPER}/health`); } catch { msg('Pomocník neběží – spusť <b>spustit-pomocnika.bat</b>.'); return; }
  if (V.playing) play();
  const id = V.song.id, W = V.W, H = V.H;
  const name = slug(`${V.song.artist} ${V.song.title}`) + (V.fmt === 'vert' ? '-9x16' : '');
  let cfg = { codec: 'avc1.640028', width: W, height: H, bitrate: 9_000_000, framerate: FPS, avc: { format: 'annexb' }, hardwareAcceleration: 'prefer-hardware' };
  if (!(await VideoEncoder.isConfigSupported(cfg)).supported) { cfg = { ...cfg, hardwareAcceleration: 'no-preference' }; }
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
  const frames = Math.ceil(V.total * FPS);
  const started = performance.now();
  try {
    await fetch(`${HELPER}/video/${id}/chunk?n=reset`, { method: 'POST', body: '' });
    sent = 0;
    for (let n = 0; n < frames; n++) {
      if (err) throw err;
      draw(n / FPS);
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
    const r = await fetch(`${HELPER}/video/${id}/finish?fps=${FPS}&pre=${PRE}&dur=${(frames / FPS).toFixed(3)}&name=${encodeURIComponent(name)}`, { method: 'POST', body: '' });
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
}
window.exportMp4 = exportMp4;

// ---------- start ----------
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

async function init() {
  const id = (location.hash.match(/[A-Za-z0-9]{4,40}/) || [])[0];
  if (!id) { msg('Chybí ID písničky v adrese (video.html#ID).'); return; }
  try {
    const song = await fetchSong(id);
    if (!song.sync) { msg('Tahle písnička ještě nemá časy – video z ní nejde udělat.'); return; }
    await document.fonts.load(`800 40px Outfit`); await document.fonts.load(`600 40px Outfit`); await document.fonts.load(`500 40px Outfit`); await document.fonts.load(`700 40px Outfit`);
    prepare(song);
    setFormat($('fmt').value);
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
  $('export').onclick = exportMp4;
  addEventListener('keydown', e => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); play(); }
    if (e.key === 'ArrowRight') seek(Math.min(V.total, nowT() + 5));
    if (e.key === 'ArrowLeft') seek(Math.max(0, nowT() - 5));
  });
  requestAnimationFrame(loop);
}
init();
