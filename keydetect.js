'use strict';
/* =========================================================
   Rozpoznání tóniny z nahrávky (běží celé v prohlížeči)
   1) dekódování + převzorkování na 11 025 Hz mono
   2) FFT po rámcích → energie 12 tónů (chroma), s odhadem ladění
   3) korelace s profily dur/moll (Krumhansl–Kessler)
   ========================================================= */
const KeyDetect = (() => {
  const SR = 11025;
  const N = 4096;          // ~0,37 s okno, rozlišení ~2,7 Hz
  const HOP = 2048;
  const MAX_SEC = 300;     // delší nahrávky: vezmeme prostředních 5 minut
  const SUB = 10;          // 10 dílků na půltón (kvůli ladění)
  const KK_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  // ---------- FFT (radix-2, in-place) ----------
  const bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / N); sinT[i] = Math.sin(-2 * Math.PI * i / N); }
  const hann = new Float64Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));

  function fft(re, im) {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cosT[k] - im[b] * sinT[k];
          const ti = re[b] * sinT[k] + im[b] * cosT[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // FFT bin → jemná pozice v oktávě (0 … 12*SUB)
  const binPos = [];
  for (let k = 1; k < N / 2; k++) {
    const f = k * SR / N;
    if (f < 65 || f > 2100) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    const p = (((midi % 12) + 12) % 12) * SUB;
    binPos.push([k, p]);
  }

  async function decode(arrayBuffer) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    try { return await ctx.decodeAudioData(arrayBuffer); }
    finally { try { ctx.close(); } catch { /* nic */ } }
  }

  async function toMono(buf) {
    const dur = Math.min(buf.duration, MAX_SEC);
    const start = Math.max(0, (buf.duration - dur) / 2);
    const off = new OfflineAudioContext(1, Math.max(N, Math.ceil(dur * SR)), SR);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start(0, start, dur);
    const out = await off.startRendering();
    return out.getChannelData(0);
  }

  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / Math.sqrt(da * db || 1);
  }

  /**
   * @param {ArrayBuffer} arrayBuffer  libovolný zvuk, který prohlížeč umí přehrát (mp3, m4a, webm, wav…)
   * @param {(p:number)=>void} onProgress  0–1
   */
  async function analyze(arrayBuffer, onProgress = () => {}) {
    const buf = await decode(arrayBuffer);
    const x = await toMono(buf);

    const fine = new Float64Array(12 * SUB);
    const frame = new Float64Array(12 * SUB);
    const re = new Float64Array(N), im = new Float64Array(N);
    const frames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);

    // hlasitost rámců → tiché pasáže přeskočíme
    let peak = 0;
    for (let i = 0; i < x.length; i += 64) peak = Math.max(peak, Math.abs(x[i]));
    const quiet = peak * 0.02;

    for (let fi = 0; fi < frames; fi++) {
      const o = fi * HOP;
      let rms = 0;
      for (let i = 0; i < N; i++) { const v = x[o + i] || 0; re[i] = v * hann[i]; im[i] = 0; rms += v * v; }
      if (Math.sqrt(rms / N) < quiet) continue;
      fft(re, im);
      frame.fill(0);
      let sum = 0;
      for (const [k, p] of binPos) {
        const mag = Math.sqrt(Math.sqrt(re[k] * re[k] + im[k] * im[k]));   // komprese dynamiky
        const i0 = Math.floor(p), t = p - i0;
        frame[i0 % frame.length] += mag * (1 - t);
        frame[(i0 + 1) % frame.length] += mag * t;
        sum += mag;
      }
      if (sum > 0) for (let i = 0; i < frame.length; i++) fine[i] += frame[i] / sum;
      if (fi % 150 === 0) { onProgress(fi / frames); await new Promise(r => setTimeout(r, 0)); }
    }
    onProgress(1);

    // ladění: kruhový průměr pozice uvnitř půltónu
    let cs = 0, sn = 0;
    for (let i = 0; i < fine.length; i++) {
      const ang = 2 * Math.PI * (i % SUB) / SUB;
      cs += fine[i] * Math.cos(ang); sn += fine[i] * Math.sin(ang);
    }
    let tune = Math.atan2(sn, cs) / (2 * Math.PI);   // −0,5 … 0,5 půltónu
    if (tune > 0.5) tune -= 1;

    // složení do 12 tónů s trojúhelníkovou vahou kolem (tón + ladění)
    const chroma = new Array(12).fill(0);
    for (let i = 0; i < fine.length; i++) {
      for (let pc = 0; pc < 12; pc++) {
        let d = i / SUB - (pc + tune);
        d -= 12 * Math.round(d / 12);
        const w = 1 - Math.abs(d);
        if (w > 0) chroma[pc] += fine[i] * w;
      }
    }

    const scores = [];
    for (let root = 0; root < 12; root++) {
      for (const minor of [false, true]) {
        const prof = minor ? KK_MIN : KK_MAJ;
        const rot = chroma.map((_, i) => prof[((i - root) % 12 + 12) % 12]);
        scores.push({ key: { root, minor }, score: pearson(chroma, rot) });
      }
    }
    scores.sort((a, b) => b.score - a.score);
    const top = scores[0].score;
    const exps = scores.map(s => Math.exp((s.score - top) * 18));
    const tot = exps.reduce((a, b) => a + b, 0);
    scores.forEach((s, i) => { s.pct = Math.round(100 * exps[i] / tot); });

    return {
      keys: scores.slice(0, 3),
      chroma,
      tuningCents: Math.round(tune * 100),
      duration: buf.duration,
    };
  }

  return { analyze };
})();
