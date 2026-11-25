'use strict';
/* =========================================================
   playalong.cz – Play-along
   Přehrávání s textem, který se přebarvuje podle zpěvu, a akordy,
   které se rozsvítí ve chvíli, kdy hrají. Režim „Doladit“ = časová osa,
   kde se slova, řádky a akordy dají posunout tažením.

   Časy jsou v song.sync:
     { v: 1, dur, lines: [ { w: [[pos, len, start, end], …], c: [[pos, time], …] } ] }
   Index řádku = index v song.lines. Vzniká v helper/align.py (Demucs + WhisperX).
   Používá globální věci z app.js (h, $, settings, current, canEdit, touch, chordName…).
   ========================================================= */

const AL = {
  id: null,          // song, pro který je načtený zvuk
  sync: null,        // pracovní kopie časů
  model: null,       // spočítané časy řádků, slov a akordů
  ctx: null, bufs: {}, gains: {}, sources: [],
  playing: false, t0: 0, offset: 0, dur: 0,
  raf: 0, loading: false, error: '', hasStems: false,
  edit: false, view0: 0, span: 12, undo: [], env: null,
  refs: null,        // odkazy do DOM pro rychlé zvýrazňování
  engine: null,      // 'wa' = stopy přes Web Audio (pomocník / MP3), 'yt' = vložené YouTube video
  yt: null, ytId: null, ytReady: false, ytState: -1, ytRaw: null, ytAt: 0,
};
const r3 = x => Math.round(x * 1000) / 1000;

// ---------- data ----------
function syncFromAlign(out) {
  return {
    v: 1, dur: r3(out.duration || 0),
    lines: (out.lines || []).map(l => ({
      w: (l.words || []).map(w => [w.pos, w.len, r3(w.start), r3(w.end)]),
      c: (l.chords || []).filter(c => c.time != null).map(c => [c.pos, r3(c.time)]),
    })),
  };
}

function buildModel(song, sync) {
  const lines = song.lines.map((line, li) => {
    const sl = sync.lines[li] || { w: [], c: [] };
    // k = index v sl.w (podle něj editor posouvá)
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
  // řádky jen s akordy (intro, mezihra): rozprostři mezi sousední zpívané řádky
  lines.forEach((L, i) => {
    if (L.s != null || !L.chords.length) return;
    if (L.chords.every(c => c.t != null)) {   // mezihra s časy akordů → řádek trvá od prvního akordu
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

const alSong = () => viewSong(current());   // zobrazení (s případnou transpozicí), neukládat
function rebuild() { AL.model = buildModel(alSong(), AL.sync); }
/** transpozice pro zobrazení se změnila */
function alongShiftChanged() { if (AL.sync) rebuild(); renderAlongBody(); }

/** uloží změnu časů (jen kdo smí song upravit) */
function commitSync() {
  const song = current();
  rebuild();
  if (!canEdit(song)) return;
  song.sync = clone(AL.sync);
  touch(song);
}
function pushSyncUndo() {
  AL.undo.push(JSON.stringify(AL.sync));
  if (AL.undo.length > 100) AL.undo.shift();
  const b = $('#alUndo'); if (b) b.disabled = false;
}
function alUndo() {
  const s = AL.undo.pop();
  if (!s) return;
  AL.sync = JSON.parse(s);
  commitSync();
  renderAlongBody();
}

// ---------- zvuk (Web Audio: vokál a doprovod hrají spolu, vokál má vlastní hlasitost) ----------
function alNow() {
  if (AL.engine === 'yt') return ytNow();
  return AL.playing ? Math.min(AL.dur, AL.ctx.currentTime - AL.t0) : AL.offset;
}
const alReady = () => AL.engine === 'yt' ? AL.ytReady : !!Object.keys(AL.bufs).length;
function alStopSources() {
  for (const s of AL.sources) { try { s.onended = null; s.stop(); } catch { /* už stojí */ } }
  AL.sources = [];
}
function alPlay() {
  if (AL.engine === 'yt') { if (AL.ytReady) AL.yt.playVideo(); return; }
  if (!AL.ctx || !Object.keys(AL.bufs).length) return;
  if (AL.ctx.state === 'suspended') AL.ctx.resume();
  alStopSources();
  if (AL.offset >= AL.dur - 0.05) AL.offset = 0;
  for (const [name, buf] of Object.entries(AL.bufs)) {
    const src = AL.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(AL.gains[name]);
    src.start(0, AL.offset);
    AL.sources.push(src);
  }
  AL.t0 = AL.ctx.currentTime - AL.offset;
  AL.playing = true;
  updatePlayBtn();
}
function alPause() {
  if (AL.engine === 'yt') { if (AL.ytReady) AL.yt.pauseVideo(); return; }
  if (!AL.playing) return;
  AL.offset = alNow();
  AL.playing = false;
  alStopSources();
  updatePlayBtn();
}
function alToggle() { if (AL.playing) alPause(); else alPlay(); }
/** skok na místo v písničce a hrát odtud (kousek předem, ať je slyšet nástup) */
function alJump(t) {
  alSeek(Math.max(0, t - 0.3));
  if (!AL.playing && alReady()) alPlay();
}
function alSeek(t) {
  AL.offset = Math.max(0, Math.min(AL.dur, t));
  if (AL.engine === 'yt') {
    if (AL.ytReady) { AL.yt.seekTo(AL.offset, true); AL.ytRaw = null; }
  } else if (AL.playing) alPlay();
  AL.lastLine = -2;
  alTick(true);
}
function setVocal(v) {
  settings.vocal = v; saveSettings();
  if (AL.gains.vocals) AL.gains.vocals.gain.value = v;
}
/** zastaví přehrávání, když uživatel odejde jinam */
function alongStop() {
  alPause();
  cancelAnimationFrame(AL.raf);
  AL.raf = 0;
  const box = $('#alYtBox');
  if (box) box.hidden = true;
  document.body.classList.remove('al-editing');
}

// ---------- YouTube (vložený přehrávač – hraje se zpěvem a funguje všem) ----------
let ytApi = null;
function loadYtApi() {
  if (ytApi) return ytApi;
  ytApi = new Promise((res, rej) => {
    if (window.YT?.Player) { res(); return; }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); res(); };
    const s = h('script', { src: 'https://www.youtube.com/iframe_api' });
    s.onerror = () => { ytApi = null; rej(new Error('yt')); };
    document.head.append(s);
  });
  return ytApi;
}
const YT_ID = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/;
const ytIdFrom = s => { s = (s || '').trim(); if (/^[\w-]{11}$/.test(s)) return s; return YT_ID.exec(s)?.[1] || null; };

async function ytStart(id) {
  AL.engine = 'yt';
  try { await loadYtApi(); } catch { AL.error = 'YouTube se nepodařilo načíst.'; renderAlongBody(); return; }
  let box = $('#alYtBox');
  if (!box) { box = h('div', { id: 'alYtBox', class: 'al-yt' }); document.body.append(box); }
  box.hidden = false;
  if (AL.yt && AL.ytId === id) return;
  if (AL.yt) { try { AL.yt.destroy(); } catch { /* nic */ } }
  box.innerHTML = '';
  box.append(h('div', { id: 'alYtPlayer' }));
  AL.ytId = id; AL.ytReady = false; AL.ytState = -1; AL.ytRaw = null;
  AL.yt = new YT.Player('alYtPlayer', {
    videoId: id, width: 356, height: 200,
    playerVars: { playsinline: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        if (AL.ytId !== id) return;
        AL.ytReady = true;
        // délka písničky: z časů (stejné video), jinak z YouTube – pokud zrovna nehraje reklama
        const d = AL.yt.getDuration() || 0;
        AL.ytDur = AL.sync?.dur && Math.abs(d - AL.sync.dur) > 3 ? AL.sync.dur : (d || AL.sync?.dur || 0);
        AL.dur = AL.ytDur;
        if (AL.offset) AL.yt.seekTo(AL.offset, true);
        if (route.view === 'along') renderAlongBody();
      },
      onStateChange: e => {
        AL.ytState = e.data;
        AL.ytMoved = false;   // dopočítávat čas až po tom, co se písnička opravdu pohne
        if (AL.engine !== 'yt') return;
        AL.playing = e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING;
        if (e.data === YT.PlayerState.ENDED) AL.playing = false;
        AL.ytRaw = null;
        updatePlayBtn();
      },
      onError: () => {
        AL.error = 'Tohle video nejde přehrát mimo YouTube (autor vložení zakázal). Zkus jiné video stejné nahrávky.';
        if (route.view === 'along') renderAlongBody();
      },
    },
  });
}
/** čas z YouTube chodí po skocích → mezi nimi dopočítáme podle hodin */
/** běží reklama? YouTube během ní hlásí délku a čas reklamy místo písničky */
function ytIsAd() {
  const d = AL.yt.getDuration?.() || 0;
  const ref = AL.ytDur || AL.sync?.dur || 0;
  return d > 0 && ref > 0 && Math.abs(d - ref) > 3;
}
function ytNow() {
  if (!AL.ytReady || !AL.yt?.getCurrentTime) return AL.offset;
  if (ytIsAd()) { AL.ytAd = true; AL.ytRaw = null; return AL.offset; }   // text čeká, kde byl
  const raw = AL.yt.getCurrentTime() || 0;
  // Během reklamy hlásí YouTube stav -1 („nespuštěno“) a getCurrentTime vrací čas REKLAMY.
  // Čas písničky platí jen ve stavech hraje / pauza / načítání / konec.
  const st = AL.yt.getPlayerState?.();
  if (st === -1 || st === 5) {
    AL.ytAd = st === -1 && raw > 0.05;
    AL.ytRaw = null; AL.ytMoved = false;
    return AL.offset;
  }
  const p = performance.now();
  if (raw !== AL.ytRaw) {
    if (AL.ytRaw != null && AL.ytState === 1 && raw > AL.ytRaw) AL.ytMoved = true;
    AL.ytRaw = raw; AL.ytAt = p;
  }
  AL.offset = raw;
  // přehrávač hlásí „hraje“, ale čas písničky se nehýbe → reklama (nebo načítání): nic nedopočítávej
  const stuck = AL.ytState === 1 && p - AL.ytAt > 900;
  AL.ytAd = stuck;
  if (AL.ytState !== 1 || stuck || !AL.ytMoved) return raw;
  return raw + Math.min(0.3, (p - AL.ytAt) / 1000);
}

/** editor: vložit / změnit odkaz na YouTube video, ze kterého časy vznikly */
function openYtPopover(anchor) {
  const input = h('input', { type: 'url', placeholder: 'https://www.youtube.com/watch?v=…', value: AL.sync?.yt ? 'https://youtu.be/' + AL.sync.yt : '' });
  const err = h('p', { class: 'form-err' });
  const save = () => {
    const id = ytIdFrom(input.value);
    if (!id) { err.textContent = 'Tohle nevypadá jako odkaz na YouTube video.'; return; }
    pushSyncUndo();
    AL.sync.yt = id;
    commitSync();
    closePopover();
    AL.error = '';
    if (!AL.hasStems) ytStart(id);
    renderAlongBody();
    toast('YouTube video uloženo k songu ✓');
  };
  input.onkeydown = e => { if (e.key === 'Enter') save(); };
  openPopover(anchor, h('div', { class: 'al-ytpop' },
    h('b', {}, 'YouTube video'),
    h('p', { class: 'hint' }, 'Stejná nahrávka, ze které vznikly časy. Pak to půjde přehrát všem, i bez pomocníka.'),
    input, err,
    h('div', { class: 'modal-actions' },
      AL.sync?.yt ? h('button', { class: 'btn ghost', onclick: () => { pushSyncUndo(); delete AL.sync.yt; commitSync(); closePopover(); renderAlongBody(); } }, 'Odebrat') : h('span'),
      h('button', { class: 'btn primary', onclick: save }, 'Uložit'))));
  setTimeout(() => input.focus(), 30);
}

async function alLoad(song) {
  AL.id = song.id;
  AL.sync = song.sync ? clone(song.sync) : null;
  AL.bufs = {}; AL.gains = {}; AL.env = null; AL.offset = 0; AL.playing = false; AL.undo = [];
  AL.error = ''; AL.hasStems = false; AL.loading = true; AL.view0 = 0; AL.engine = null;
  if (AL.yt) { try { AL.yt.pauseVideo(); } catch { /* nic */ } }
  renderAlongBody();
  try {
    const avail = await fetch(`${HELPER}/stems/${song.id}/`, { signal: AbortSignal.timeout(2500) }).then(r => r.ok ? r.json() : null);
    if (avail?.['sync.json'] && !AL.sync) {
      const out = await fetch(`${HELPER}/stems/${song.id}/sync.json`).then(r => r.json());
      AL.sync = syncFromAlign(out);
      if (canEdit(song)) { song.sync = clone(AL.sync); touch(song); }
    }
    if (avail?.['vocals.mp3'] && avail?.['no_vocals.mp3']) {
      await alDecode({
        vocals: `${HELPER}/stems/${song.id}/vocals.mp3`,
        no_vocals: `${HELPER}/stems/${song.id}/no_vocals.mp3`,
      });
      AL.hasStems = true;
      AL.engine = 'wa';
    }
  } catch { /* pomocník neběží – pustíme YouTube, nebo nabídneme výběr MP3 */ }
  AL.loading = false;
  if (AL.id !== song.id) return;
  if (AL.sync) rebuild();
  if (!AL.hasStems && AL.sync?.yt) ytStart(AL.sync.yt);
  renderAlongBody();
}

async function alDecode(urls) {
  AL.ctx = AL.ctx || new (window.AudioContext || window.webkitAudioContext)();
  const entries = await Promise.all(Object.entries(urls).map(async ([name, src]) => {
    const data = src instanceof ArrayBuffer ? src : await fetch(src).then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); });
    return [name, await AL.ctx.decodeAudioData(data)];
  }));
  for (const [name, buf] of entries) {
    AL.bufs[name] = buf;
    const g = AL.ctx.createGain();
    g.gain.value = name === 'vocals' ? (settings.vocal ?? 1) : 1;
    g.connect(AL.ctx.destination);
    AL.gains[name] = g;
  }
  AL.dur = Math.max(...entries.map(([, b]) => b.duration));
  const voc = AL.bufs.vocals || AL.bufs.mix;
  AL.env = voc ? envelope(voc) : null;
}

/** hlasitost vokálu po 20 ms – pro časovou osu v editoru */
function envelope(buf) {
  const ch = buf.getChannelData(0), hop = Math.round(buf.sampleRate * 0.02);
  const out = new Float32Array(Math.ceil(ch.length / hop));
  let max = 1e-6;
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    const a = i * hop, b = Math.min(ch.length, a + hop);
    for (let j = a; j < b; j += 4) s += ch[j] * ch[j];
    out[i] = Math.sqrt(s / Math.max(1, (b - a) / 4));
    if (out[i] > max) max = out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(out[i] / max);
  return out;
}

function pickMp3() {
  const inp = h('input', { type: 'file', accept: 'audio/*' });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    AL.loading = true; renderAlongBody();
    try {
      if (AL.engine === 'yt') { alPause(); const box = $('#alYtBox'); if (box) box.hidden = true; }
      AL.bufs = {}; AL.gains = {}; AL.engine = 'wa'; AL.playing = false; AL.offset = 0;
      await alDecode({ mix: await f.arrayBuffer() });
    } catch { toast('Tenhle soubor se nepodařilo přehrát.'); }
    AL.loading = false; renderAlongBody();
  };
  inp.click();
}

// ---------- vykreslení ----------
function renderAlong() {
  const song = current();
  if (!song) return;
  document.body.classList.add('playing');
  renderTopActions([h('a', { class: 'btn ghost', href: '#' }, '← Songy')]);
  if (AL.id !== song.id) { alongStop(); alLoad(song); return; }
  if (!AL.sync && song.sync) { AL.sync = clone(song.sync); rebuild(); }
  if (AL.engine === 'yt') { const box = $('#alYtBox'); if (box) box.hidden = false; }
  renderAlongBody();
}

function renderAlongBody() {
  const song = alSong();
  const app = $('#app');
  if (!song || !app) return;
  const editable = canEdit(song);
  if (!editable) AL.edit = false;
  const ready = alReady();
  document.body.classList.toggle('al-editing', AL.edit);
  app.innerHTML = '';

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const bar = h('div', { class: 'play-bar al-bar' },
    h('a', { class: 'pb-back', href: '#play-' + song.id, title: 'Zpět na text' }, '←'),
    h('div', { class: 'pb-name', title: (song.artist ? song.artist + ' – ' : '') + song.title },
      song.artist ? h('span', { class: 'pb-artist' }, song.artist + ' – ') : null,
      h('b', {}, song.title || 'Bez názvu')),
    h('div', { class: 'controls' },
      h('button', { id: 'alPlay', class: 'btn primary al-play', disabled: !ready || !AL.sync, onclick: alToggle, title: 'Přehrát / pauza (mezerník)' }, AL.playing ? '❚❚' : '▶'),
      h('span', { id: 'alTime', class: 'al-time' }, fmt(alNow()) + ' / ' + fmt(AL.dur || AL.sync?.dur || 0)),
      h('input', {
        id: 'alSeek', class: 'al-seek', type: 'range', min: 0, max: Math.max(1, AL.dur), step: 0.1, value: alNow(),
        disabled: !ready, 'aria-label': 'Posun v písničce',
        oninput: e => alSeek(+e.target.value),
      }),
      h('div', { class: 'tgroup', title: 'Transpozice – jen pro zobrazení, písnička se nemění' },
        h('button', { onclick: () => transpose(-1), 'aria-label': 'Transponovat dolů' }, '−'),
        h('button', { class: 'tr-val' + (viewShift ? ' moved' : ''), onclick: () => { if (viewShift) transpose(-viewShift); }, title: 'Klik vrátí originál' }, stepLabel(viewShift)),
        h('button', { onclick: () => transpose(1), 'aria-label': 'Transponovat nahoru' }, '+')),
      AL.hasStems && AL.sync?.yt ? h('button', {
        class: 'tbtn', title: 'Přepnout, odkud hraje hudba. YouTube = tak, jak to slyší ostatní.',
        onclick: () => alSwitchSource(AL.engine === 'yt' ? 'wa' : 'yt'),
      }, AL.engine === 'yt' ? 'Zdroj: YouTube' : 'Zdroj: moje stopy') : null,
      AL.hasStems && AL.engine === 'wa' ? h('label', { class: 'al-voc', title: 'Hlasitost zpěvu – úplně vlevo = karaoke bez vokálu' },
        h('span', {}, (settings.vocal ?? 1) < 0.05 ? '🎸' : '🎤'),
        h('input', {
          type: 'range', min: 0, max: 1, step: 0.05, value: settings.vocal ?? 1, 'aria-label': 'Hlasitost vokálu',
          oninput: e => { setVocal(+e.target.value); e.target.previousSibling.textContent = +e.target.value < 0.05 ? '🎸' : '🎤'; },
        })) : null,
      editable && AL.sync ? h('button', {
        class: 'tbtn' + (AL.sync.yt ? ' on' : ''), title: AL.sync.yt ? 'YouTube video k songu – klik pro změnu' : 'Přidat YouTube video, ať play-along funguje všem',
        onclick: e => openYtPopover(e.currentTarget),
      }, '▶ YouTube') : null,
      editable && AL.sync ? h('button', {
        class: 'tbtn' + (AL.edit ? ' on' : ''), title: 'Doladit časy tažením na časové ose',
        onclick: () => { AL.edit = !AL.edit; AL.view0 = Math.max(0, alNow() - AL.span * 0.25); renderAlongBody(); },
      }, '✎ Doladit') : null,
      AL.edit ? h('button', { id: 'alUndo', class: 'tbtn', onclick: alUndo, disabled: !AL.undo.length, title: 'Vrátit poslední posun (Ctrl+Z)' }, '↶ Zpět') : null));

  const ed = h('div', { class: 'editor play along' + (AL.edit ? ' al-editing' : '') }, bar);

  if (AL.loading) {
    ed.append(h('div', { class: 'empty' }, h('div', { class: 'big-emoji' }, '🎧'), h('h2', {}, 'Načítám zvuk…')));
    app.append(ed);
    return;
  }
  if (!AL.sync) {
    ed.append(h('div', { class: 'empty al-empty' },
      h('div', { class: 'big-emoji' }, '⏱'),
      h('h2', {}, 'Tahle písnička ještě nemá časy'),
      h('p', {}, 'Časy textu a akordů vzniknou z nahrávky (oddělení vokálu + rozpoznání zpěvu). Zatím se připravují přes pomocníka na počítači.')));
    app.append(ed);
    return;
  }

  ed.append(h('div', { class: 'al-now' },
    h('div', { class: 'al-cur-wrap' }, h('small', {}, 'Hraje'), h('span', { id: 'alCur', class: 'chord al-cur' }, '–')),
    h('div', { class: 'al-next-wrap' },
      h('small', {}, 'Další'), h('span', { id: 'alNext', class: 'chord al-next' }, '–'),
      h('div', { class: 'al-meter' }, h('i', { id: 'alMeter' }))),
    h('div', { id: 'alAd', class: 'al-src al-ad', hidden: true }, '📺 Reklama nebo načítání na YouTube – text počká'),
    AL.error ? h('div', { class: 'al-src al-err' }, AL.error) : null,
    !ready && AL.engine === 'yt' && !AL.error ? h('div', { class: 'al-src' }, 'Načítám YouTube…') : null,
    !ready && AL.engine !== 'yt' ? h('div', { class: 'al-src' },
      h('span', {}, editable ? 'Bez zvuku. Přidej ▶ YouTube video, spusť pomocníka, nebo ' : 'Bez zvuku. Spusť pomocníka, nebo '),
      h('button', { class: 'btn', onclick: pickMp3 }, '🎵 vyber MP3')) : null));

  const sheet = h('div', { class: 'sheet al-sheet', id: 'alSheet' });
  ed.append(h('div', { class: 'sheet-wrap' }, sheet));
  if (AL.edit) ed.append(renderTimelineShell());
  app.append(ed);

  renderAlongSheet(sheet);
  if (AL.edit) renderTimeline();
  AL.lastLine = -2;
  alTick(true);
  if (!AL.raf) AL.raf = requestAnimationFrame(alLoop);
}

function renderAlongSheet(sheet) {
  const song = alSong();
  const refs = { lines: [], chords: new Map() };
  let sec = null;
  const counts = {};
  AL.model.lines.forEach(L => {
    const line = song.lines[L.li];
    if (line.section) {
      sec = line.section;
      counts[sec] = (counts[sec] || 0) + 1;
      const total = song.lines.filter(l => l.section === sec).length;
      // klik na štítek části = přehrát od začátku té části
      const startL = AL.model.lines.slice(L.li).find(x => x.s != null);
      sheet.append(h('div', { class: 'al-sec' }, h('button', {
        class: 'sec-label al-sec-btn', 'data-s': sec, title: 'Přehrát od začátku této části',
        onclick: () => { if (startL) alJump(startL.s); },
      }, '▶ ' + secLabel(sec) + (sec === 'verse' && total > 1 ? ' ' + counts[sec] : ''))));
    }
    if (!line.text && !line.chords.length) { sheet.append(h('div', { class: 'gap' })); refs.lines[L.li] = null; return; }
    const el = h('div', { class: 'line al-line' + (line.chords.length ? ' has-chords' : '') + (!line.text ? ' instr' : ''), 'data-li': L.li, 'data-s': sec || null });
    const minPos = line.chords.reduce((m, c) => Math.min(m, c.pos), 0);
    if (minPos < 0) el.style.setProperty('--pre', String(-minPos));
    const len = Math.max(line.text.length, line.chords.reduce((m, c) => Math.max(m, c.pos + 1), 0), 1);
    const chars = [];
    const wordOf = new Map();
    L.words.forEach(w => { for (let i = w.pos; i < w.pos + w.len; i++) wordOf.set(i, w); });
    for (let i = minPos; i < len; i++) {
      const ch = i >= 0 && i < line.text.length ? line.text[i] : null;
      const span = h('span', { class: 'c' + (ch == null ? ' pad' : '') + (i < 0 ? ' pre' : ''), 'data-i': i }, ch == null ? ' ' : ch);
      const w = wordOf.get(i);
      if (w) { span.dataset.w = w.k; chars.push({ el: span, w, i }); }
      const c = L.chords.find(x => x.pos === i);
      if (c) {
        const ce = h('span', { class: 'chord ' + degClass(c.ch.root, song.key) }, chordName(c.ch, song.key));
        span.append(ce);
        refs.chords.set(L.li + ':' + i, ce);
      }
      el.append(span);
    }
    // klik na slovo = skok na to místo
    el.addEventListener('click', e => {
      const c = e.target.closest('.c');
      const w = c && L.words.find(x => x.k === +c.dataset.w);
      // u mezihry: klik na konkrétní akord = od toho akordu
      const chEl = e.target.closest('.c');
      const cc = !w && chEl && L.chords.find(x => x.pos === +chEl.dataset.i && x.t != null);
      const t = w ? w.s : cc ? cc.t : L.s;
      if (t != null) alJump(t);
    });
    sheet.append(el);
    refs.lines[L.li] = { el, chars, L };
  });
  AL.refs = refs;
}

// ---------- zvýrazňování (každý snímek) ----------
function alLoop() {
  AL.raf = requestAnimationFrame(alLoop);
  if (!$('#alSheet')) { cancelAnimationFrame(AL.raf); AL.raf = 0; return; }
  if (AL.engine === 'wa' && AL.playing && alNow() >= AL.dur - 0.02) { alPause(); AL.offset = 0; }
  alTick(false);
}

function alTick(force) {
  if (!AL.model || !AL.refs) return;
  const t = alNow();
  const song = alSong();
  const ad = $('#alAd');
  if (ad) ad.hidden = !(AL.engine === 'yt' && AL.ytAd);
  // čas
  const time = $('#alTime');
  if (time) {
    const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    time.textContent = fmt(t) + ' / ' + fmt(AL.dur || AL.sync?.dur || 0);
  }
  const seek = $('#alSeek');
  if (seek && document.activeElement !== seek) seek.value = t;

  // aktuální řádek = poslední, který už začal (s malým předstihem)
  const lines = AL.model.lines;
  let cur = -1;
  for (const L of lines) if (L.s != null && L.s <= t + 0.25 && AL.refs.lines[L.li]) cur = L.li;
  if (cur !== AL.lastLine || force) {
    AL.refs.lines.forEach((r, li) => {
      if (!r) return;
      r.el.classList.toggle('past', li < cur);
      r.el.classList.toggle('cur', li === cur);
      if (li !== cur) r.chars.forEach(c => c.el.classList.remove('on'));
    });
    if (cur >= 0 && !AL.edit || (cur >= 0 && AL.playing)) {
      const el = AL.refs.lines[cur].el;
      const r = el.getBoundingClientRect();
      const target = window.scrollY + r.top - innerHeight * 0.38;
      if (Math.abs(r.top - innerHeight * 0.38) > 40) window.scrollTo({ top: target, behavior: force ? 'auto' : 'smooth' });
    }
    AL.lastLine = cur;
  }
  // přebarvení po písmenkách v aktuálním řádku
  const r = cur >= 0 && AL.refs.lines[cur];
  if (r) {
    for (const c of r.chars) {
      const w = c.w;
      const k = c.i - w.pos;
      c.el.classList.toggle('on', t >= w.s + (w.e - w.s) * (k / Math.max(1, w.len)));
    }
  }
  // akordy
  const ch = AL.model.chords;
  let ci = -1;
  for (let i = 0; i < ch.length; i++) { if (ch[i].t <= t + 0.05) ci = i; else break; }
  if (ci !== AL.lastChord || force) {
    if (AL.nowChordEl) AL.nowChordEl.classList.remove('now');
    const c = ci >= 0 ? ch[ci] : null;
    AL.nowChordEl = c ? AL.refs.chords.get(c.li + ':' + c.pos) : null;
    if (AL.nowChordEl) AL.nowChordEl.classList.add('now');
    const setBig = (el, c) => {
      if (!el) return;
      el.textContent = c ? chordName(c.ch, song.key) : '–';
      el.className = el.id === 'alCur' ? 'chord al-cur' : 'chord al-next';
      if (c) el.classList.add(degClass(c.ch.root, song.key));
    };
    setBig($('#alCur'), c);
    setBig($('#alNext'), ch[ci + 1]);
    AL.lastChord = ci;
  }
  const meter = $('#alMeter');
  if (meter) {
    const a = ci >= 0 ? ch[ci].t : 0, b = ch[ci + 1]?.t;
    meter.style.width = b ? Math.min(100, Math.max(0, (t - a) / Math.max(0.1, b - a) * 100)) + '%' : '0%';
  }
  if (AL.edit) tlPlayhead(t);
}

// ---------- časová osa (Doladit) ----------
const TL = { lanes: { line: [4, 26], word: [34, 30], chord: [70, 26] }, wave: [100, 56] };

function renderTimelineShell() {
  return h('div', { class: 'al-tl', id: 'alTl' },
    h('div', { class: 'tl-tools' },
      h('span', { class: 'tl-hint' }, 'Táhni slovo, akord nebo celý řádek. Klik do prázdna = skok.'),
      h('button', { class: 'tbtn', title: 'Oddálit', onclick: () => tlZoom(1.5) }, '−'),
      h('button', { class: 'tbtn', title: 'Přiblížit', onclick: () => tlZoom(1 / 1.5) }, '+')),
    h('div', { class: 'tl-area', id: 'tlArea' },
      h('canvas', { id: 'tlWave' }),
      h('div', { class: 'tl-lab', style: `top:${TL.lanes.line[0]}px` }, 'Řádky'),
      h('div', { class: 'tl-lab', style: `top:${TL.lanes.word[0]}px` }, 'Slova'),
      h('div', { class: 'tl-lab', style: `top:${TL.lanes.chord[0]}px` }, 'Akordy'),
      h('div', { class: 'tl-items', id: 'tlItems' }),
      h('div', { class: 'tl-head', id: 'tlHead' })));
}
function tlZoom(f) {
  const mid = AL.view0 + AL.span / 2;
  AL.span = Math.max(3, Math.min(60, AL.span * f));
  AL.view0 = Math.max(0, mid - AL.span / 2);
  renderTimeline();
}
const tlWidth = () => $('#tlArea')?.clientWidth || 800;
const tlX = t => (t - AL.view0) / AL.span * tlWidth();

function renderTimeline() {
  const area = $('#tlArea'), items = $('#tlItems'), cv = $('#tlWave');
  if (!area || !items || !cv) return;
  const song = alSong();
  const W = area.clientWidth, H = area.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
  cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const css = getComputedStyle(document.documentElement);
  // mřížka po sekundách
  g.fillStyle = css.getPropertyValue('--line') || '#ddd';
  g.font = '11px Outfit, sans-serif';
  for (let s = Math.ceil(AL.view0); s < AL.view0 + AL.span; s++) {
    const x = tlX(s);
    g.fillRect(x, 0, 1, H);
    if (s % (AL.span > 20 ? 5 : 1) === 0) {
      g.fillStyle = css.getPropertyValue('--muted') || '#888';
      g.fillText(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`, x + 3, H - 4);
      g.fillStyle = css.getPropertyValue('--line') || '#ddd';
    }
  }
  // vlna vokálu
  if (AL.env) {
    const [top, hgt] = TL.wave;
    const mid = top + hgt / 2;
    g.fillStyle = css.getPropertyValue('--d5') || '#a6f';
    g.globalAlpha = 0.55;
    for (let x = 0; x < W; x++) {
      const t = AL.view0 + x / W * AL.span;
      const v = AL.env[Math.floor(t / 0.02)] || 0;
      g.fillRect(x, mid - v * hgt / 2, 1, Math.max(1, v * hgt));
    }
    g.globalAlpha = 1;
  }

  items.innerHTML = '';
  const t0 = AL.view0 - 1, t1 = AL.view0 + AL.span + 1;
  for (const L of AL.model.lines) {
    const line = song.lines[L.li];
    if (L.s != null && L.e != null && L.e >= t0 && L.s <= t1 && L.words.length) {
      items.append(tlItem('line', L, null, tlX(L.s), Math.max(8, tlX(L.e) - tlX(L.s)), line.text.slice(0, 60)));
    }
    for (const w of L.words) {
      if (w.e < t0 || w.s > t1) continue;
      items.append(tlItem('word', L, w, tlX(w.s), Math.max(6, tlX(w.e) - tlX(w.s)), line.text.substr(w.pos, w.len)));
    }
    for (const c of L.chords) {
      if (c.t == null || c.t < t0 || c.t > t1) continue;
      const el = tlItem('chord', L, c, tlX(c.t), 0, chordName(c.ch, song.key));
      el.classList.add(degClass(c.ch.root, song.key));
      items.append(el);
    }
  }
  // klik do prázdna = skok, kolečko = posun
  area.onpointerdown = e => {
    if (e.target.closest('.tl-it')) return;
    const r = area.getBoundingClientRect();
    alSeek(AL.view0 + (e.clientX - r.left) / W * AL.span);
  };
  area.onwheel = e => {
    e.preventDefault();
    const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) / W * AL.span;
    AL.view0 = Math.max(0, AL.view0 + d);
    renderTimeline();
  };
  tlPlayhead(alNow());
}

function tlItem(kind, L, obj, x, w, label) {
  const [top, hgt] = TL.lanes[kind];
  const el = h('div', { class: 'tl-it tl-' + kind, style: `left:${x}px;top:${top}px;height:${hgt}px;` + (kind === 'chord' ? '' : `width:${w}px`), title: label }, label);
  el._L = L;
  el.addEventListener('pointerdown', e => tlDrag(e, el, kind, L, obj));
  return el;
}

/** tažení položky na časové ose */
function tlDrag(e, el, kind, L, obj) {
  e.preventDefault();
  e.stopPropagation();
  const x0 = e.clientX;
  const pps = tlWidth() / AL.span;
  let moved = false;
  // co se posouvá spolu: u řádku i jeho slova a akordy (náhled)
  const group = kind === 'line'
    ? [...$('#tlItems').children].filter(it => it._L === L)
    : [el];
  group.forEach(it => { it._left0 = parseFloat(it.style.left); });
  el.setPointerCapture(e.pointerId);
  el.classList.add('dragging');
  const move = ev => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 3) return;
    moved = true;
    group.forEach(it => { it.style.left = (it._left0 + dx) + 'px'; });
    el.dataset.d = (dx / pps >= 0 ? '+' : '−') + Math.abs(dx / pps).toFixed(2) + ' s';
  };
  const up = ev => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.classList.remove('dragging');
    if (!moved) {   // klik = přehraj od tohoto místa
      const t = kind === 'chord' ? obj.t : kind === 'word' ? obj.s : L.s;
      alSeek(t - 0.3);
      if (!AL.playing) alPlay();
      return;
    }
    const d = (ev.clientX - x0) / pps;
    pushSyncUndo();
    shiftSync(kind, L, obj, d);
    commitSync();
    renderAlongBody();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

/** posun v datech: slovo (i s akordy nad ním), akord, nebo celý řádek */
function shiftSync(kind, L, obj, d) {
  const sl = AL.sync.lines[L.li] || (AL.sync.lines[L.li] = { w: [], c: [] });
  // akordy, které ještě nemají vlastní čas, si ho teď uloží (ať se nehýbou s jinými slovy)
  for (const c of L.chords) if (c.t != null && !sl.c.some(x => x[0] === c.pos)) sl.c.push([c.pos, r3(c.t)]);
  if (kind === 'chord') {
    const e = sl.c.find(x => x[0] === obj.pos);
    if (e) e[1] = r3(Math.max(0, e[1] + d));
  } else if (kind === 'word') {
    const w = sl.w[obj.k];
    if (!w) return;
    const len = w[3] - w[2];
    w[2] = r3(Math.max(0, w[2] + d)); w[3] = r3(w[2] + len);
    for (const c of sl.c) if (c[0] >= w[0] && c[0] < w[0] + Math.max(1, w[1])) c[1] = r3(Math.max(0, c[1] + d));
  } else {
    for (const w of sl.w) { const len = w[3] - w[2]; w[2] = r3(Math.max(0, w[2] + d)); w[3] = r3(w[2] + len); }
    for (const c of sl.c) c[1] = r3(Math.max(0, c[1] + d));
  }
}

function tlPlayhead(t) {
  const head = $('#tlHead');
  if (!head) return;
  // při přehrávání drž playhead v záběru
  if (AL.playing && (t > AL.view0 + AL.span * 0.85 || t < AL.view0)) {
    AL.view0 = Math.max(0, t - AL.span * 0.2);
    renderTimeline();
    return;
  }
  head.style.left = tlX(t) + 'px';
}

/** přepnutí mezi stopami z pomocníka a YouTube videem (na stejném místě písničky) */
function alSwitchSource(engine) {
  const t = alNow();
  alPause();
  if (engine === 'yt') {
    AL.offset = t;
    ytStart(AL.sync.yt).then(() => { if (AL.ytReady) AL.yt.seekTo(t, true); });
  } else {
    const box = $('#alYtBox');
    if (box) box.hidden = true;
    AL.engine = 'wa';
    AL.playing = false;
    AL.offset = t;
  }
  renderAlongBody();
}

function updatePlayBtn() {
  const b = $('#alPlay');
  if (b) b.textContent = AL.playing ? '❚❚' : '▶';
}

window.addEventListener('resize', () => { if (AL.edit && $('#tlArea')) renderTimeline(); });
