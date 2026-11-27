// playalong.cz – „továrna“: průvodce zpracováním písničky po workeru (jen admin)
//   krok 1 Tempo:  marker začátku + ťukání dob 1 2 3 4 (15–30 s) → mřížka dob pro celou píseň
//   krok 2 Akordy: ťukání změn akordů → časy akordů (přicvaknuté na mřížku)
//   krok 3 Vzhled: v editoru akordů posunout akordy na správné místo (čas se tím nemění)
// Stav je v song.sync.stage: 'beats' → 'chords' → 'done'. Načítá se po along.js, před app.js.

const FAC = { taps: [], start: null, meter: 4, idx: 0, click: false, lastBeat: -1, ac: null };
const STAGES = { beats: '1 · Tempo', chords: '2 · Akordy', done: 'hotovo' };
const stageOf = s => (!s?.sync ? 'nosync' : s.sync.stage || 'done');

// ---------- seznam ----------
function renderFactoryList() {
  const app = $('#app');
  app.innerHTML = '';
  document.body.classList.remove('playing');
  renderTopActions([h('a', { class: 'btn ghost', href: '#' }, '← Songy')]);
  const wrap = h('div', { class: 'wrap factory' }, h('h1', {}, '🏭 Továrna'),
    h('p', { class: 'sub' }, 'Písničky po automatickém zpracování. Projdi u každé 3 kroky: tempo, akordy, vzhled.'));
  if (!auth.admin) { wrap.append(h('p', {}, 'Jen pro admina.')); app.append(wrap); return; }
  const order = { beats: 0, chords: 1, nosync: 2, done: 3 };
  const list = [...songs].sort((a, b) => (order[stageOf(a)] - order[stageOf(b)]) || (a.title || '').localeCompare(b.title || '', 'cs'));
  const ul = h('ul', { class: 'fac-list' });
  for (const s of list) {
    const st = s.partial ? (s.hasSync ? '…' : 'nosync') : stageOf(s);
    ul.append(h('li', {},
      h('span', { class: 'fac-name' }, (s.artist ? s.artist + ' – ' : '') + (s.title || 'Bez názvu')),
      h('span', { class: 'fac-stage fac-' + st }, st === 'nosync' ? 'bez časů' : STAGES[st] || st),
      st !== 'nosync' ? h('a', { class: 'btn primary', href: '#tovarna-' + s.id }, st === 'done' ? 'Upravit' : 'Zpracovat') : null));
  }
  wrap.append(ul);
  app.append(wrap);
  // seznam má jen názvy – stav (sync.stage) se dočte u nenačtených
  const missing = list.filter(s => s.partial && s.hasSync);
  if (missing.length && window.KSB_SUPA) Promise.all(missing.slice(0, 30).map(s => window.KSB_SUPA.ensureLoaded(s.id).catch(() => null)))
    .then(() => { if (route.view === 'factory') renderFactoryList(); });
}

// ---------- panel průvodce (v play-alongu) ----------
function beatPeriod() {
  const b = AL.sync?.beats;
  if (!b || b.length < 3) return 0.5;
  const d = b.slice(1).map((x, i) => x - b[i]).sort((x, y) => x - y);
  return d[d.length >> 1];
}
function nearestBeatT(t) { return typeof nearestBeat === 'function' ? nearestBeat(t) : t; }

function factoryPanel(song) {
  const stage = FAC.forceStage || AL.sync?.stage || 'done';   // aktuální (rozpracovaný) stav
  const step = (n, label, key) => h('button', {
    class: 'fac-step' + (stage === key ? ' on' : ''),
    onclick: () => { FAC.forceStage = null; setStage(key); },
  }, n + ' ' + label);
  const head = h('div', { class: 'fac-steps' },
    h('a', { class: 'btn ghost', href: '#tovarna' }, '← Továrna'),
    step('1', 'Tempo', 'beats'), step('2', 'Akordy', 'chords'), step('3', 'Vzhled', 'done'));
  const box = h('div', { class: 'fac-panel' }, head);
  if (stage === 'beats') box.append(panelBeats());
  else if (stage === 'chords') box.append(panelChords());
  else box.append(panelLook(song));
  return box;
}

function setStage(stage) {
  AL.sync.stage = stage;
  commitSync();
  FAC.taps = []; FAC.idx = -1;
  renderAlongBody();
}

const fmtT = s => s == null ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function panelBeats() {
  const P = beatPeriod();
  const bpm = Math.round(60 / P);
  if (FAC.start == null && AL.sync.start != null) FAC.start = AL.sync.start;
  return h('div', { class: 'fac-body' },
    h('div', { class: 'fac-row' },
      h('span', { class: 'fac-metro', id: 'facMetro', title: 'Metronom podle nalezených dob – takhle rychle ťukej' }, ...Array.from({ length: FAC.meter }, () => h('i'))),
      h('span', { class: 'al-lead' }, `~${bpm} BPM`),
      h('div', { class: 'tgroup' },
        h('button', { class: FAC.click ? 'on' : '', title: 'Cvakání metronomu v odhadnutém tempu', onclick: () => { FAC.click = !FAC.click; renderAlongBody(); } }, FAC.click ? '🔊 Metronom' : '🔈 Metronom'),
        h('button', { title: 'Metrum', onclick: () => { FAC.meter = FAC.meter === 3 ? 4 : 3; renderAlongBody(); } }, FAC.meter + '/4')),
      h('div', { class: 'tgroup' },
        h('button', { title: 'Začátek písně = aktuální místo (marker 📍 jde pak táhnout na ose)', onclick: () => setStart(alNow()) }, '📍 Start = teď'),
        h('button', { disabled: FAC.start == null, title: 'Přehrát kousek před startem', onclick: () => { alSeek(Math.max(0, FAC.start - 2)); if (!AL.playing) alPlay(); } }, '▶ od startu')),
      h('span', { class: 'al-lead', id: 'facStartT' }, 'start ' + fmtT(FAC.start)),
      h('button', { class: 'btn fac-tap', onpointerdown: e => { e.preventDefault(); facTap(); } }, 'ŤUK (K)'),
      h('span', { class: 'al-lead', id: 'facCount' }, `ťuků: ${FAC.taps.length}`),
      h('div', { class: 'tgroup' },
        h('button', { disabled: !FAC.taps.length, onclick: () => { FAC.taps = []; renderAlongBody(); } }, '✕ Znovu'),
        h('button', { class: 'fac-ok', id: 'facApply', disabled: FAC.taps.length < 8, onclick: applyBeatTaps }, '✓ Použít a dál'))),
    h('div', { class: 'tl-hint' }, 'Dej 📍 na začátek písně (nebo ho přetáhni na ose), pusť a ťukej K na každou dobu 1 2 3 4 – první ťuk = 1. doba taktu. Stačí 15–30 s.'));
}

function setStart(t) {
  FAC.start = r3(Math.max(0, t));
  AL.sync.start = FAC.start;
  commitSync();
  const el = document.getElementById('facStartT');
  if (el) el.textContent = 'start ' + fmtT(FAC.start);
  renderTimeline();
}

function facTap() {
  const t = alNow();
  if (FAC.taps.length && t - FAC.taps[FAC.taps.length - 1] < 0.15) return;
  if ((FAC.forceStage || AL.sync?.stage) === 'chords') { tapChord(t); return; }
  FAC.taps.push(t);
  const c = document.getElementById('facCount');
  if (c) c.textContent = `ťuků: ${FAC.taps.length}`;
  const a = document.getElementById('facApply');
  if (a) a.disabled = FAC.taps.length < 8;
  renderTimeline();
}

/** z ťuků dob udělá mřížku pro celou píseň.
 *  Když ťuky sedí na jedno tempo (odchylka < 7 % doby, tempo na začátku a na konci stejné), je mřížka pevná až do konce.
 *  Když tempo plave, jde mřížka podle ťuků (klouzavě), mimo ťuky pokračuje tempem z kraje ťuků. */
function fitTapGrid(tapsIn, start, dur) {
  const taps = [...tapsIn].sort((a, b) => a - b);
  const d = taps.slice(1).map((x, i) => x - taps[i]).sort((x, y) => x - y);
  const P0 = d[d.length >> 1];
  // číslo doby postupně (vynechané doby se dopočítají, zrychlení nevadí)
  const ks = [0];
  for (let i = 1; i < taps.length; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((taps[i] - taps[i - 1]) / P0)));
  const lsq = idx => {
    const n = idx.length, sk = idx.reduce((s, i) => s + ks[i], 0), st = idx.reduce((s, i) => s + taps[i], 0);
    const skk = idx.reduce((s, i) => s + ks[i] * ks[i], 0), skt = idx.reduce((s, i) => s + ks[i] * taps[i], 0);
    const P = (n * skt - sk * st) / Math.max(1e-9, n * skk - sk * sk);
    return { P, a: (st - P * sk) / n };
  };
  // jedno tempo přes všechno, odlehlé ťuky pryč
  let use = taps.map((_, i) => i), fit = lsq(use);
  for (let it = 0; it < 3; it++) {
    const res = use.map(i => Math.abs(taps[i] - (fit.a + fit.P * ks[i])));
    const lim = Math.max(0.04, [...res].sort((x, y) => x - y)[res.length >> 1] * 3);
    const nu = use.filter((i, j) => res[j] <= lim);
    if (nu.length < 8) break;
    use = nu; fit = lsq(use);
  }
  // jak moc se ťuky drží jednoho tempa (klouzavý medián odchylky)
  const res = use.map(i => taps[i] - (fit.a + fit.P * ks[i]));
  let drift = 0;
  for (let j = 0; j < res.length; j++) {
    const w = res.slice(Math.max(0, j - 4), j + 5).sort((x, y) => x - y);
    drift = Math.max(drift, Math.abs(w[w.length >> 1]));
  }
  const steady = drift < fit.P * 0.07 && Math.abs(lsq(use.slice(0, 16)).P / lsq(use.slice(-16)).P - 1) < 0.015;
  const k0 = ks[use[0]], kN = ks[use[use.length - 1]];
  let at, Pa, Pb, ta, tb;
  if (steady) {
    at = k => fit.a + fit.P * k;
    Pa = Pb = fit.P; ta = at(k0); tb = at(kN);
  } else {
    // každý ťuk vyhladit přímkou přes sousedy (±8), mezi ťuky lineárně
    const sm = use.map((_, j) => {
      const win = use.slice(Math.max(0, j - 8), j + 9), f = lsq(win);
      return [ks[use[j]], f.a + f.P * ks[use[j]]];
    });
    const edge = win => lsq(win).P;
    Pa = edge(use.slice(0, 16)); Pb = edge(use.slice(-16));
    ta = sm[0][1]; tb = sm[sm.length - 1][1];
    at = k => {
      if (k <= sm[0][0]) return ta + (k - sm[0][0]) * Pa;
      if (k >= sm[sm.length - 1][0]) return tb + (k - sm[sm.length - 1][0]) * Pb;
      let lo = 0, hi = sm.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (sm[m][0] <= k) lo = m; else hi = m; }
      const [ka, xa] = sm[lo], [kb, xb] = sm[hi];
      return xa + (xb - xa) * (k - ka) / (kb - ka);
    };
  }
  const from = start != null ? start - Pa * 0.5 : 0;
  const kMin = k0 - Math.floor((ta - Math.max(0, from)) / Pa);
  const kMax = kN + Math.floor((dur - tb) / Pb);
  const beats = [];
  for (let k = kMin; k <= kMax; k++) { const t = at(k); if (t >= 0 && t <= dur) beats.push(t); }
  return { beats, firstK: kMin, P: fit.P, steady, drift, tapEnd: taps[taps.length - 1] };
}

function applyBeatTaps() {
  if (FAC.taps.length < 8) return;
  const dur = AL.dur || AL.sync.dur || Math.max(...FAC.taps) + 30;
  const g = fitTapGrid(FAC.taps, FAC.start, dur);
  pushSyncUndo();
  AL.sync.beats = g.beats.map(r3);
  AL.sync.taps = [...FAC.taps].sort((a, b) => a - b).map(r3);   // syrové ťuky – ať jdou přepočítat
  AL.sync.meter = FAC.meter;
  AL.sync.bar0 = ((-g.firstK) % FAC.meter + FAC.meter) % FAC.meter;   // první ťuk = 1. doba taktu
  if (FAC.start != null) AL.sync.start = FAC.start;
  AL.sync.stage = 'chords';
  FAC.taps = []; FAC.forceStage = null; FAC.idx = -1;
  commitSync();
  renderAlongBody();
  const bpm = Math.round(60 / g.P);
  toast(g.steady
    ? `Pevné tempo ${bpm} BPM – ťuky sedí, mřížka až do konce ✓ Teď akordy.`
    : `Tempo se hýbe (průměr ${bpm} BPM) – mřížka jde podle ťuků, za ${fmtT(g.tapEnd)} odhad. Pro jistotu ťukej až do konce.`);
}

// ---------- krok 2: akordy ----------
function chordSeq() { return AL.model.chords.filter(c => c.t != null || true); }
function panelChords() {
  const seq = chordSeq();
  if (FAC.idx < 0 || FAC.idx > seq.length) {
    const st = AL.sync.start ?? 0;
    FAC.idx = Math.max(0, seq.findIndex(c => (c.t ?? 0) >= st - 0.5));
  }
  const song = alSong();
  const next = seq[FAC.idx];
  const lineTxt = next ? (song.lines[next.li].text || '(mezihra)').slice(0, 40) : '';
  return h('div', { class: 'fac-body' },
    h('div', { class: 'fac-row' },
      h('span', { class: 'al-lead' }, 'další:'),
      next ? h('span', { class: 'chord ' + degClass(next.ch.root, song.key), id: 'facNext' }, chordName(next.ch, song.key)) : h('b', { id: 'facNext' }, 'hotovo ✓'),
      h('span', { class: 'muted fac-line', id: 'facNextLine' }, next ? `ř. ${next.li + 1}: ${lineTxt}` : ''),
      h('span', { class: 'al-lead', id: 'facCount' }, `${Math.min(FAC.idx, seq.length)} / ${seq.length}`),
      h('button', { class: 'btn fac-tap', onpointerdown: e => { e.preventDefault(); facTap(); } }, 'ŤUK (K)'),
      h('div', { class: 'tgroup' },
        h('button', { title: 'Vrátit poslední ťuk', disabled: !FAC.idx, onclick: () => { alUndo(); FAC.idx = Math.max(0, FAC.idx - 1); renderAlongBody(); } }, '↶ Ťuk'),
        h('button', { title: 'Začít od prvního akordu po startu', onclick: () => { FAC.idx = -1; alSeek(Math.max(0, (AL.sync.start ?? 0) - 2)); renderAlongBody(); } }, '⏮ Od startu'),
        h('button', { title: 'Další ťuk patří prvnímu akordu po tomhle místě', onclick: () => { const t = alNow(); FAC.idx = Math.max(0, seq.findIndex(c => (c.t ?? 0) >= t - 0.3)); renderAlongBody(); } }, '↪ Odsud'),
        h('button', { title: 'Každý akord posunout na nejbližší dobu nové mřížky (jde vrátit ↶)', onclick: snapAllChords }, '🧲 Všechny na doby'),
        h('button', { class: 'fac-ok', onclick: () => setStage('done') }, '✓ Hotovo, dál'))),
    h('div', { class: 'tl-hint' }, 'Pusť písničku a ťukni K pokaždé, když se změní akord (zvýrazněný blok na ose). Přicvakne se na dobu, se Shiftem přesně.'));
}

/** všechny akordy na nejbližší dobu (dva akordy na jednu dobu → druhý zůstane, kde byl) */
function snapAllChords() {
  if (!AL.sync?.beats?.length) return;
  pushSyncUndo();
  let moved = 0, last = -1;
  const all = AL.model.lines.flatMap(L => L.chords.filter(c => c.t != null).map(c => ({ L, c })))
    .sort((x, y) => x.c.t - y.c.t);
  for (const { L, c } of all) {
    const to = nearestBeat(c.t);
    if (Math.abs(to - last) < 0.01) { last = c.t; continue; }
    if (Math.abs(to - c.t) > 0.001) { shiftSync('chord', L, c, to - c.t); moved++; }
    last = to;
  }
  commitSync();
  renderAlongBody();
  toast(`🧲 ${moved} akordů přicvaknuto na doby.`);
}

function tapChord(t) {
  const seq = chordSeq();
  const c = seq[FAC.idx];
  if (!c) return;
  const L = AL.model.lines.find(x => x.li === c.li);
  const shift = !!window.event?.shiftKey;
  const to = shift ? t : nearestBeatT(t);
  pushSyncUndo();
  if (c.t == null) c.t = to;
  shiftSync('chord', L, c, to - c.t);
  commitSync();
  FAC.idx++;
  // jen obnov ukazatele (celé překreslení by rušilo přehrávání)
  const n = seq[FAC.idx], song = alSong();
  const el = document.getElementById('facNext');
  if (el) { el.textContent = n ? chordName(n.ch, song.key) : '✓'; el.className = 'chord ' + (n ? degClass(n.ch.root, song.key) : ''); }
  const ln = document.getElementById('facNextLine');
  if (ln) ln.textContent = n ? `ř. ${n.li + 1}: ${(song.lines[n.li].text || '(mezihra)').slice(0, 40)}` : '';
  const cnt = document.getElementById('facCount');
  if (cnt) cnt.textContent = `${Math.min(FAC.idx, seq.length)} / ${seq.length}`;
  AL.lastChord = -2;
  renderTimeline();
}

// ---------- krok 3: vzhled ----------
function panelLook(song) {
  return h('div', { class: 'fac-body' },
    h('div', { class: 'fac-row' },
      h('a', { class: 'btn primary', href: '#song-' + song.id }, '✎ Otevřít editor akordů'),
      h('a', { class: 'btn ghost', href: '#along-' + song.id }, '▶ Vyzkoušet Play Along')),
    h('div', { class: 'tl-hint' }, 'V editoru akordů posuň akordy tam, kde mají být v textu (ať nejsou dva vedle sebe nebo na špatném řádku). Čas v Play Alongu se tím nezmění. Časy tady pořád jdou doladit tažením.'));
}

// ---------- na časové ose: marker startu, ťuky, další akord ----------
function facIsNext(c) {
  if ((FAC.forceStage || AL.sync?.stage) !== 'chords') return false;
  const n = chordSeq()[FAC.idx];
  return !!n && n.li === c.li && n.pos === c.pos;
}
function factoryTimeline(items, g, W, H) {
  const stage = FAC.forceStage || AL.sync?.stage;
  if (stage === 'beats' && FAC.taps.length) {
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--d0') || '#e33';
    g.globalAlpha = 0.85;
    for (const t of FAC.taps) {
      const x = tlX(t);
      if (x >= -2 && x <= W + 2) g.fillRect(x - 1, TL.ruler, 3, H - TL.ruler);
    }
    g.globalAlpha = 1;
  }
  const st = AL.sync?.start;
  if (st == null) return;
  const mk = h('div', { class: 'tl-it fac-start', style: `left:${tlX(st)}px`, title: 'Začátek písně – táhni' }, h('span', {}, '📍 Start'));
  mk.onpointerdown = e => {
    e.preventDefault(); e.stopPropagation();
    try { mk.setPointerCapture(e.pointerId); } catch { /* nic */ }
    const x0 = e.clientX, s0 = AL.sync.start;
    let v = s0;
    const mv = ev => {
      v = Math.max(0, s0 + (ev.clientX - x0) / tlWidth() * AL.span);
      mk.style.left = tlX(v) + 'px';
      const el = document.getElementById('facStartT');
      if (el) el.textContent = 'start ' + fmtT(v);
    };
    const up = () => {
      mk.removeEventListener('pointermove', mv); mk.removeEventListener('pointerup', up);
      if (v !== s0) setStart(v);
    };
    mk.addEventListener('pointermove', mv);
    mk.addEventListener('pointerup', up);
  };
  items.append(mk);
}

// ---------- metronom: puls (a cvak) na nalezených dobách ----------
function factoryTick() {
  if (!AL.factory) return;
  const dots = document.querySelectorAll('#facMetro i');
  const b = AL.sync?.beats;
  if (!dots.length || !b?.length) return;
  const t = alNow();
  let i = -1;
  for (let lo = 0, hi = b.length - 1; lo <= hi;) { const m = (lo + hi) >> 1; if (b[m] <= t) { i = m; lo = m + 1; } else hi = m - 1; }
  if (i < 0) return;
  const m = AL.sync.meter || FAC.meter || 4, b0 = AL.sync.bar0 ?? 0;
  const pos = ((i - b0) % m + m) % m;
  dots.forEach((d, k) => d.classList.toggle('on', k === pos && t - b[i] < 0.15));
  if (FAC.click && AL.playing && i !== FAC.lastBeat) {
    FAC.lastBeat = i;
    try {
      FAC.ac = FAC.ac || new (window.AudioContext || window.webkitAudioContext)();
      const o = FAC.ac.createOscillator(), g = FAC.ac.createGain();
      o.frequency.value = pos === 0 ? 1600 : 1000;
      g.gain.setValueAtTime(0.25, FAC.ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, FAC.ac.currentTime + 0.05);
      o.connect(g).connect(FAC.ac.destination);
      o.start(); o.stop(FAC.ac.currentTime + 0.06);
    } catch { /* nic */ }
  }
}
