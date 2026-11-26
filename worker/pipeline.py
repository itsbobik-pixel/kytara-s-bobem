"""playalong.cz – výpočet časů pro play-along z nahrávky a textu písničky.

Vstup:  zvuk (mp3/wav…) + písnička {lines:[{text, chords:[{pos, root, q, bass}], section}], key}
Výstup: sync {v:1, dur, lines:[{w:[[pos,len,start,end]], c:[[pos,time]]}]} – stejný formát jako song.sync v appce.

Kroky:
  1. Demucs oddělí vokál a doprovod.
  2. WhisperX přepíše vokál a zarovná slova; naše slova se namapují na přepis (Needleman-Wunsch).
  3. Doby: onset obálka doprovodu + odhad tempa + dynamické sledování dob.
  4. Akordy: pořadí z textu; každý akord se přicvakne na dobu poblíž svého slova
     (segmentové DP, rozhoduje chroma shoda se šablonou akordu). Akordy v řádcích bez textu
     (mezihra, intro, outro) dostanou odhad času mezi sousedy a hledají se v širším okně.

GPU části (1, 2) jsou v separate()/transcribe(); 3 a 4 běží i na CPU (lokální test: test_local.py).
"""
import json, os, re, subprocess, sys, unicodedata
from difflib import SequenceMatcher
import numpy as np

SR = 22050
HOP = 0.1
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


# ---------------------------------------------------------------- audio
def load(path, sr=SR):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(sr), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def separate(audio, outdir):
    subprocess.run([sys.executable, '-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs',
                    '--mp3', '--mp3-bitrate', '192', '-o', outdir, audio], check=True)
    base = os.path.splitext(os.path.basename(audio))[0]
    d = os.path.join(outdir, 'htdemucs', base)
    return os.path.join(d, 'vocals.mp3'), os.path.join(d, 'no_vocals.mp3')


# ---------------------------------------------------------------- slova
def norm(w):
    w = unicodedata.normalize('NFD', w.lower())
    w = ''.join(c for c in w if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', w)


_WX = {}


def transcribe(vocals, lang, prompt):
    import whisperx
    dev = 'cuda'
    if 'asr' not in _WX:
        _WX['asr'] = whisperx.load_model('large-v3', dev, compute_type='float16', language=lang)
    model = _WX['asr']
    # text písničky jako nápověda (výrazně víc správně poznaných slov); options je dataclass nebo namedtuple
    import dataclasses
    try:
        model.options = dataclasses.replace(model.options, initial_prompt=prompt[:800])
    except TypeError:
        try:
            model.options = model.options._replace(initial_prompt=prompt[:800])
        except Exception as e:  # noqa: BLE001
            print('initial_prompt nejde nastavit:', e)
    audio = whisperx.load_audio(vocals)
    res = model.transcribe(audio, batch_size=8, language=lang)
    key = 'align_' + lang
    if key not in _WX:
        _WX[key] = whisperx.load_align_model(language_code=lang, device=dev)
    amodel, meta = _WX[key]
    res = whisperx.align(res['segments'], amodel, meta, audio, dev, return_char_alignments=False)
    words = []
    for seg in res['segments']:
        for w in seg.get('words', []):
            if 'start' in w and norm(w['word']):
                words.append({'w': w['word'], 'n': norm(w['word']), 'start': float(w['start']), 'end': float(w['end'])})
    return words


def our_words(lines):
    out = []
    for li, l in enumerate(lines):
        for m in re.finditer(r'\S+', l.get('text') or ''):
            n = norm(m.group())
            if n:
                out.append({'line': li, 'pos': m.start(), 'len': len(m.group()), 'n': n})
    return out


def _sim(a, b):
    return 1.0 if a == b else SequenceMatcher(None, a, b).ratio()


def match(ours, theirs):
    n, m = len(ours), len(theirs)
    GAP = -0.4
    score = np.zeros((n + 1, m + 1))
    back = np.zeros((n + 1, m + 1), dtype=np.int8)
    score[1:, 0] = np.arange(1, n + 1) * GAP; back[1:, 0] = 1
    score[0, 1:] = np.arange(1, m + 1) * GAP * 0.5; back[0, 1:] = 2
    S = np.array([[_sim(o['n'], t['n']) for t in theirs] for o in ours]) if n and m else np.zeros((n, m))
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = S[i - 1, j - 1]
            d = score[i - 1, j - 1] + (s * 2 - 1 if s >= 0.5 else -1.0)
            u = score[i - 1, j] + GAP
            l = score[i, j - 1] + GAP * 0.5
            if d >= u and d >= l:
                score[i, j] = d; back[i, j] = 0
            elif u >= l:
                score[i, j] = u; back[i, j] = 1
            else:
                score[i, j] = l; back[i, j] = 2
    for o in ours:
        o['t'] = None
    i, j = n, m
    while i > 0 and j > 0:
        b = back[i, j]
        if b == 0:
            if S[i - 1, j - 1] >= 0.5:
                ours[i - 1]['t'] = j - 1
            i -= 1; j -= 1
        elif b == 1:
            i -= 1
        else:
            j -= 1


def fill_times(ours, theirs):
    for o in ours:
        if o['t'] is not None:
            o['start'], o['end'], o['ok'] = theirs[o['t']]['start'], theirs[o['t']]['end'], True
        else:
            o['start'] = o['end'] = None; o['ok'] = False
    known = [k for k, o in enumerate(ours) if o['ok']]
    if not known:
        return
    for k, o in enumerate(ours):
        if o['ok']:
            continue
        prev = max((x for x in known if x < k), default=None)
        nxt = min((x for x in known if x > k), default=None)
        same_prev = prev is not None and ours[prev]['line'] == o['line']
        same_next = nxt is not None and ours[nxt]['line'] == o['line']
        if prev is None or (same_next and not same_prev):
            o['start'] = max(0.0, ours[nxt]['start'] - 0.35 * (nxt - k))
        elif nxt is None or (same_prev and not same_next):
            o['start'] = ours[prev]['end'] + 0.35 * (k - prev - 1) + 0.05
        else:
            a, b = ours[prev]['end'], ours[nxt]['start']
            o['start'] = a + (b - a) * (k - prev) / (nxt - prev)
        o['end'] = o['start'] + 0.3


def words_to_sync(lines, ours):
    """sync.lines[].w = [[pos, len, start, end], ...] (jako v appce)."""
    out = [[] for _ in lines]
    for o in ours:
        out[o['line']].append([o['pos'], o['len'], round(o['start'], 3), round(o['end'], 3)])
    return out


# ---------------------------------------------------------------- doby
def onset_env(x, oh=0.01):
    N, hop = 2048, int(SR * oh)
    win = np.hanning(N).astype(np.float32)
    n = (len(x) - N) // hop
    idx = np.arange(N)[None, :] + hop * np.arange(n)[:, None]
    env = np.zeros(n, dtype=np.float32)
    prev = None
    for s in range(0, n, 2000):           # po blocích kvůli paměti
        fr = x[idx[s:s + 2000]] * win
        m = np.log1p(np.abs(np.fft.rfft(fr, axis=1))[:, :400])
        if prev is not None:
            m_prev = np.vstack([prev[None, :], m[:-1]])
        else:
            m_prev = np.vstack([m[:1], m[:-1]])
        env[s:s + len(m)] = np.maximum(m - m_prev, 0).sum(1)
        prev = m[-1]
    return (env - env.mean()) / (env.std() + 1e-9)


def estimate_period(env, oh=0.01, lo_bpm=60, hi_bpm=180):
    e = env - env.mean()
    ac = np.correlate(e, e, 'full')[len(e) - 1:]
    lags = np.arange(len(ac))
    lo, hi = int(60 / hi_bpm / oh), int(60 / lo_bpm / oh)
    # váha preferující ~100–130 BPM (log-normální kolem 0,5 s), aby se nechytala polovina/dvojnásobek
    w = np.exp(-0.5 * (np.log2(lags[lo:hi] * oh / 0.52) / 0.9) ** 2)
    k = lo + int(np.argmax(ac[lo:hi] * w))
    # zpřesnění parabolou
    if 1 <= k < len(ac) - 1:
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        d = 0.5 * (a - c) / (a - 2 * b + c + 1e-9)
        return (k + d) * oh
    return k * oh


def track_beats(env, period, oh=0.01, tight=6.0):
    P = period / oh
    T = len(env)
    score = env.astype(np.float64).copy()
    back = np.full(T, -1)
    lo, hi = int(P * 0.75), int(P * 1.33)
    for t in range(hi, T):
        taus = np.arange(t - hi, t - lo + 1)
        pen = -tight * np.log((t - taus) / P) ** 2
        cand = score[taus] + pen
        k = int(cand.argmax())
        score[t] = env[t] + cand[k]
        back[t] = taus[k]
    t = int(np.argmax(score[-int(P):])) + T - int(P)
    beats = []
    while t >= 0:
        beats.append(t * oh)
        t = back[t]
    return np.array(beats[::-1])


# ---------------------------------------------------------------- akordy
def chroma(x):
    N = 8192
    hop = int(SR * HOP)
    win = np.hanning(N).astype(np.float32)
    freqs = np.fft.rfftfreq(N, 1 / SR)
    sel = (freqs > 60) & (freqs < 1000)
    pc = ((np.round(12 * np.log2(freqs[sel] / 440.0)) + 9) % 12).astype(int)
    frames = []
    for s in range(0, len(x) - N, hop):
        mag = np.abs(np.fft.rfft(x[s:s + N] * win))[sel]
        frames.append(np.sqrt(np.bincount(pc, weights=mag ** 2, minlength=12)))
    C = np.array(frames)
    pad = int((N / 2) / hop)
    C = np.vstack([np.repeat(C[:1], pad, 0), C])
    return C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)


def is_minor(q):
    q = q or ''
    return q.startswith('m') and not q.startswith('maj')


def template(root, minor):
    t = np.zeros(12)
    t[root % 12] = 1.0
    t[(root + (3 if minor else 4)) % 12] = 0.45
    t[(root + 7) % 12] = 0.55
    return t / np.linalg.norm(t)


def chord_items(lines, wsync, step=2.0):
    """Akordy v pořadí písně s odhadem času ze slova nad kterým stojí (None u řádků bez textu)."""
    items = []
    for li, l in enumerate(lines):
        words = wsync[li]
        for c in sorted(l.get('chords', []), key=lambda c: c['pos']):
            t = None
            if words:
                p = max(0, c['pos'])
                t = words[0][2]
                for pos, ln, s, e in words:
                    if pos <= p:
                        t = s + (e - s) * min(1.0, (p - pos) / max(1, ln)) if p < pos + ln + 1 else e
                if c['pos'] < 0:          # akord před textem: o něco dřív
                    t = words[0][2] - 0.25 * (-c['pos'])
            items.append({'li': li, 'pos': c['pos'], 'key': (c['root'], c.get('q') or ''), 't': t})
    # řádky bez textu: rovnoměrně mezi známými sousedy
    known = [k for k, it in enumerate(items) if it['t'] is not None]
    for k, it in enumerate(items):
        if it['t'] is not None:
            continue
        it['free'] = True
        prev = max((x for x in known if x < k), default=None)
        nxt = min((x for x in known if x > k), default=None)
        if prev is not None and nxt is not None:
            a, b = items[prev]['t'], items[nxt]['t']
            it['t'] = a + (b - a) * (k - prev) / (nxt - prev)
        elif prev is not None:
            it['t'] = items[prev]['t'] + step * (k - prev)
        elif nxt is not None:
            it['t'] = max(0.0, items[nxt]['t'] - step * (nxt - k))
        else:
            it['t'] = step * k
    return items


def snap_chords(items, beats, C, dur, EARLY=4.5, LATE=2.2, FREE=24.0, LAMBDA=0.35):
    types = {}
    for it in items:
        types.setdefault(it['key'], len(types))
    tm = np.array([template(r, is_minor(q)) for r, q in types])
    S = C @ tm.T
    cs = np.vstack([np.zeros((1, S.shape[1])), np.cumsum(S, 0)])
    fr = lambda t: int(min(len(S), max(0, round(t / HOP))))
    seg = lambda typ, a, b: cs[fr(b), typ] - cs[fr(a), typ]
    bl = float(np.median(np.diff(beats)))
    K = len(items)
    cands = []
    for it in items:
        e, l = (FREE, FREE) if it.get('free') else (EARLY, LATE)
        j = np.where((beats >= it['t'] - e * bl) & (beats <= it['t'] + l * bl))[0]
        if len(j) == 0:
            j = np.array([int(np.abs(beats - it['t']).argmin())])
        cands.append(j)

    def prior(k, j):
        if items[k].get('free'):
            return 0.0
        return -LAMBDA * max(0.0, abs(beats[j] - items[k]['t']) / bl - 0.5)

    dp = [dict() for _ in range(K)]
    bk = [dict() for _ in range(K)]
    for j in cands[0]:
        dp[0][int(j)] = prior(0, j)
    for k in range(1, K):
        tp = types[items[k - 1]['key']]
        prevs = sorted(dp[k - 1].items())
        for j in cands[k]:
            best, arg = -1e18, None
            for jp, v in prevs:
                if jp >= j:
                    break
                if j - jp > 48:
                    continue
                s = v + seg(tp, beats[jp], beats[j])
                if s > best:
                    best, arg = s, jp
            if arg is not None:
                dp[k][int(j)] = best + prior(k, j)
                bk[k][int(j)] = arg
        if not dp[k]:   # nic nenavazuje – nouzově nejbližší doba po předchozím
            jp = max(dp[k - 1], key=dp[k - 1].get)
            j = min(len(beats) - 1, jp + 1)
            dp[k][j] = dp[k - 1][jp]; bk[k][j] = jp
    lt = types[items[-1]['key']]
    end = min(dur, items[-1]['t'] + 6)
    if items[-1].get('free'):   # poslední akord bez textu: nesmí utéct do doznění
        for j in list(dp[-1]):
            if beats[j] > items[-1]['t'] + LATE * bl * 2:
                del dp[-1][j]
    jb = max(dp[-1], key=lambda j: dp[-1][j] + seg(lt, beats[j], end))
    assign = [0] * K
    assign[-1] = jb
    for k in range(K - 1, 0, -1):
        assign[k - 1] = bk[k][assign[k]]
    for it, j in zip(items, assign):
        it['time'] = round(float(beats[j]), 3)
    return items


# ---------------------------------------------------------------- celé
def compute_sync(lines, vocals_path, inst_path, words=None, lang='cs', log=print):
    """words=None → přepis WhisperX (GPU). Jinak words = sync.lines[].w (test bez GPU)."""
    stats = {}
    if words is None:
        prompt = ' '.join(l['text'] for l in lines if (l.get('text') or '').strip())
        theirs = transcribe(vocals_path, lang, prompt)
        ours = our_words(lines)
        match(ours, theirs)
        fill_times(ours, theirs)
        words = words_to_sync(lines, ours)
        stats.update(ours=len(ours), transcribed=len(theirs), matched=sum(o['ok'] for o in ours))
        # řádky, kde se nenašlo skoro nic (text nesedí s nahrávkou)
        bad = []
        for li, l in enumerate(lines):
            ws = [o for o in ours if o['line'] == li]
            if len(ws) >= 3 and sum(o['ok'] for o in ws) / len(ws) < 0.4:
                bad.append(li)
        stats['badLines'] = bad
        stats['transcript'] = ' '.join(t['w'] for t in theirs)
        log('slova: %(matched)d / %(ours)d' % stats)
    inst = load(inst_path)
    dur = len(inst) / SR
    env = onset_env(inst)
    period = estimate_period(env)
    beats = track_beats(env, period)
    stats.update(beat=round(float(np.median(np.diff(beats))), 4), bpm=round(60 / float(np.median(np.diff(beats))), 1), beats=len(beats))
    log('doby: %d, tempo %.1f BPM' % (len(beats), stats['bpm']))
    items = chord_items(lines, words, step=2 * float(np.median(np.diff(beats))))   # bez textu: ~2 doby na akord
    if items:
        C = chroma(inst)
        snap_chords(items, beats, C, dur)
    csync = [[] for _ in lines]
    for it in items:
        csync[it['li']].append([it['pos'], it['time']])
    sync = {'v': 1, 'dur': round(dur, 2), 'lines': [{'w': w, 'c': c} for w, c in zip(words, csync)]}
    return sync, stats, beats
