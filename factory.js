// playalong.cz – „továrna“: jediné místo, kde se ladí časy písničky po workeru (jen admin)
//   všechno v jedné liště nad časovou osou:
//   Akordy pre (normální editor) · praporek startu · ťukání: Doby (mřížka) / Akordy (časy akordů) · Akordy after
//   Akordy after = editor, kde jde akordy jen posouvat v textu – časy se nemění.
// song.sync.stage jen pro seznam: 'beats' (bez tempa) → 'chords' (tempo hotové) → 'done'. Načítá se po along.js, před app.js.

const FAC = { taps: [], start: null, meter: 4, idx: 0, click: false, lastBeat: -1, ac: null };
const STAGES = { beats: 'bez tempa', chords: 'tempo ✓', done: 'hotovo' };
const stageOf = s => (!s?.sync ? 'nosync' : s.sync.stage || 'done');

// ---------- seznam ----------
// v továrně jsou songy, které nejsou hotové: neschválené / soukromé, nebo s nedodělanými časy
const facWanted = s => !isReady(s) || (!s.partial && (stageOf(s) === 'beats' || stageOf(s) === 'chords'));
function renderFactoryList() {
  const app = $('#app');
  app.innerHTML = '';
  document.body.classList.remove('playing');
  renderTopActions([favToggle(false), playlistsToggle(false), factoryToggle(true)]);
  const wrap = h('div', { class: 'wrap factory' }, h('h1', {}, '🏭 Továrna'),
    h('p', { class: 'sub' }, 'Písničky, které ještě nejsou hotové: start, tempo (ťukání dob), časy akordů, Akordy after a schválení.'));
  if (!auth.admin) { wrap.append(h('p', {}, 'Jen pro admina.')); app.append(wrap); return; }
  const order = { beats: 0, chords: 1, nosync: 2, done: 3 };
  const list = songs.filter(facWanted)
    .sort((a, b) => (order[stageOf(a)] - order[stageOf(b)]) || (a.title || '').localeCompare(b.title || '', 'cs'));
  const ul = h('ul', { class: 'fac-list' });
  if (!list.length) ul.append(h('li', {}, h('span', { class: 'fac-name' }, 'Všechno je hotové 🎉')));
  for (const s of list) {
    const st = s.partial ? (s.hasSync ? '…' : 'nosync') : stageOf(s);
    const fit = window.KSB_SUPA?.jobFit?.(s.id);
    ul.append(h('li', {},
      h('span', { class: 'fac-name' }, (s.artist ? s.artist + ' – ' : '') + (s.title || 'Bez názvu')),
      fit ? h('span', { class: 'sl-pending', title: 'text = kolik slov se našlo v nahrávce, akordy = kolik akordů opravdu zní' },
        `text ${fit.text} %` + (fit.chords != null ? ` · akordy ${fit.chords} %` : '')) : null,
      window.KSB_SUPA?.jobStatus?.(s.id) ? h('span', { class: 'sl-pending' }, '⏳ připravuje se') : null,
      s.isPublic === false ? h('span', { class: 'fac-stage' }, 'soukromý') : null,
      h('span', { class: 'fac-stage fac-' + st }, st === 'nosync' ? 'bez časů' : STAGES[st] || st),
      s.approved === false ? h('button', {
        class: 'sl-approve', title: 'Schválit – uvidí ho všichni',
        onclick: async () => {
          try { await window.KSB_SUPA.approve(s.id); s.approved = true; renderFactoryList(); toast(`„${s.title}“ je schválený ✓`); }
          catch { toast('Schválení se nepovedlo, zkus to znovu.'); }
        },
      }, '✓ Schválit') : null,
      st !== 'nosync' ? h('a', { class: 'btn primary', href: '#tovarna-' + s.id }, st === 'done' ? 'Upravit' : 'Zpracovat')
        : h('a', { class: 'btn', href: '#play-' + s.id }, 'Otevřít')));
  }
  wrap.append(ul);
  app.append(wrap);
  // seznam má jen názvy – stav (sync.stage) se dočte u nenačtených
  const missing = songs.filter(s => s.partial && s.hasSync);
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

/** co se právě ťuká: 'beats' = doby (klávesa K), 'chords' = změny akordů (klávesa J) */
function facMode() {
  if (!AL.factory) return null;
  if (!AL.sync?.beats?.length) return 'beats';
  return FAC.mode || (AL.sync?.stage === 'beats' ? 'beats' : 'chords');
}
function setFacMode(m) { FAC.mode = m; }

/** tlačítka továrny – všechno v jedné liště nad časovou osou */
function factoryPanel(song) {
  return h('div', { class: 'fac-tools' },
    h('div', { class: 'tgroup' },
      h('button', { title: 'Akordy pre: normální editor (akordy, text, části) – před ťukáním časů', onclick: () => { location.hash = '#pre-' + song.id; } }, 'Akordy pre'),
      h('button', { title: 'Akordy after: jen posunout akordy v textu, kam patří – časy se nemění', onclick: () => { location.hash = '#after-' + song.id; } }, 'Akordy after')),
    h('div', { class: 'tgroup' },
      h('button', { title: 'Začátek písně = aktuální místo (praporek jde taky táhnout na ose)', onclick: () => setStart(alNow()) }, ico('flag'), ' ', h('span', { id: 'facStartT' }, fmtT(FAC.start ?? AL.sync?.start))),
      h('button', { disabled: (FAC.start ?? AL.sync?.start) == null, title: 'Přehrát od startu (kousek před ním)', onclick: () => { alSeek(Math.max(0, (FAC.start ?? AL.sync.start) - 2)); if (!AL.playing) alPlay(); } }, '▶')),
    h('div', { class: 'fac-taps' }, tapBtn('beats'), AL.sync?.beats?.length ? tapBtn('chords') : null),
    ...panelBeats(),
    ...(AL.sync?.beats?.length ? panelChords() : []),
    leadControl(),
    h('div', { class: 'tgroup' },
      h('button', { class: AL.sync?.stage === 'done' ? 'on' : '', title: 'Písnička je hotová (v seznamu továrny)', onclick: () => setStage('done') }, '✓ Hotovo')));
}

function setStage(stage) {
  AL.sync.stage = stage;
  commitSync();
  renderAlongBody();
  if (stage === 'done') toast('Hotovo ✓');
}

const fmtT = s => s == null ? '–' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

function panelBeats() {
  if (FAC.start == null && AL.sync.start != null) FAC.start = AL.sync.start;
  FAC.meter = AL.sync.meter || 4;
  return [
    h('div', { class: 'tgroup' },
      h('button', { title: 'Smazat ťuky a začít znovu', disabled: !FAC.taps.length, onclick: () => { FAC.taps = []; renderAlongBody(); } }, '✕'),
      h('button', { class: 'fac-ok', id: 'facApply', title: 'Složit z ťuků mřížku dob', disabled: FAC.taps.length < 8, onclick: applyBeatTaps }, '✓ Použít')),
  ];
}

function setStart(t) {
  FAC.start = r3(Math.max(0, t));
  AL.sync.start = FAC.start;
  commitSync();
  const el = document.getElementById('facStartT');
  if (el) el.textContent = fmtT(FAC.start);
  renderTimeline();
}

function facTap() {
  const t = alNow();
  if (FAC.taps.length && t - FAC.taps[FAC.taps.length - 1] < 0.15) return;
  if (facMode() === 'chords') { tapChord(t); return; }
  FAC.taps.push(t);
  const c = document.getElementById('facCountB');
  if (c) c.textContent = FAC.taps.length;
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
  if (AL.sync.stage === 'beats' || !AL.sync.stage) AL.sync.stage = 'chords';
  FAC.taps = []; FAC.mode = 'chords'; FAC.idx = -1;
  commitSync();
  renderAlongBody();
  const bpm = Math.round(60 / g.P);
  toast(g.steady
    ? `Pevné tempo ${bpm} BPM – ťuky sedí, mřížka až do konce ✓ Teď ťukej akordy.`
    : `Tempo se hýbe (průměr ${bpm} BPM) – mřížka jde podle ťuků, za ${fmtT(g.tapEnd)} odhad. Pro jistotu ťukej až do konce.`);
}

// ---------- ťukání akordů ----------
function chordSeq() { return AL.model.chords.filter(c => c.t != null || true); }
/** ťukací tlačítka: obrázek klávesy (K = doby, J = akordy) + malý počet; popisek při najetí */
function tapBtn(kind) {
  const beats = kind === 'beats';
  const seq = beats ? null : chordSeq();
  const tip = beats
    ? 'ŤUK doby (klávesa K): pusť písničku a ťukej na každou dobu 1 2 3 4 – první ťuk = 1. doba taktu. Pak ✓ Použít.'
    : 'ŤUK akordy (klávesa J): ťukni pokaždé, když se změní akord. Ťuk patří akordu nejblíž (pak dalším po řadě). Přicvakne se na dobu, se Shiftem přesně.';
  return h('button', {
    class: 'fac-tap fac-tap-' + kind, 'data-tip': tip, 'aria-label': tip,
    onpointerdown: e => { e.preventDefault(); setFacMode(kind); facTap(); },
  },
    h('span', { class: 'fac-key' }, beats ? 'K' : 'J'),
    h('span', { class: 'fac-ico' }, beats ? '🥁' : '🎸'),
    h('small', { id: beats ? 'facCountB' : 'facCount' }, beats ? FAC.taps.length : `${Math.max(0, Math.min(FAC.idx, seq.length))}/${seq.length}`));
}
function panelChords() {
  const seq = chordSeq();
  if (FAC.idx < 0 || FAC.idx > seq.length) FAC.idx = 0;
  const song = alSong();
  const next = seq[FAC.idx];
  return [
    h('span', { class: 'fac-next-chip', title: next ? `další akord – ř. ${next.li + 1}: ${(song.lines[next.li].text || '(mezihra)').slice(0, 40)}` : '' },
      next ? h('span', { class: 'chord ' + degClass(next.ch.root, song.key), id: 'facNext' }, chordName(next.ch, song.key)) : h('b', { id: 'facNext' }, '✓')),
  ];
}

function tapChord(t) {
  const seq = chordSeq();
  // první ťuk, ťuk po přetočení zpět nebo po delší pauze → patří akordu nejblíž (jinak další po řadě)
  if (FAC.lastTap == null || t < FAC.lastTap - 0.2 || t - FAC.lastTap > 6) {
    let best = -1, bd = Infinity;
    seq.forEach((x, i) => { if (x.t != null && Math.abs(x.t - t) < bd) { bd = Math.abs(x.t - t); best = i; } });
    if (best >= 0) FAC.idx = best;
  }
  FAC.lastTap = t;
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
  if (ln) ln.textContent = n ? `ř. ${n.li + 1}` : '';
  const cnt = document.getElementById('facCount');
  if (cnt) cnt.textContent = `${Math.min(FAC.idx, seq.length)}/${seq.length}`;
  AL.lastChord = -2;
  renderTimeline();
}

// ---------- na časové ose: marker startu, ťuky, další akord ----------
function facIsNext(c) {
  if (!AL.factory) return false;
  const n = chordSeq()[FAC.idx];
  return !!n && n.li === c.li && n.pos === c.pos;
}
function factoryTimeline(items, g, W, H) {
  if (FAC.taps.length) {
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
  const mk = h('div', { class: 'tl-it fac-start', style: `left:${tlX(st)}px`, title: 'Začátek písně – táhni' }, h('span', {}, ico('flag'), ' Start'));
  mk.onpointerdown = e => {
    e.preventDefault(); e.stopPropagation();
    try { mk.setPointerCapture(e.pointerId); } catch { /* nic */ }
    const x0 = e.clientX, s0 = AL.sync.start;
    let v = s0;
    const mv = ev => {
      v = Math.max(0, s0 + (ev.clientX - x0) / tlWidth() * AL.span);
      mk.style.left = tlX(v) + 'px';
      const el = document.getElementById('facStartT');
      if (el) el.textContent = fmtT(v);
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
