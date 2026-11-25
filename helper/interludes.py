"""playalong.cz – najde mezihry (ticho ve stopě vokálu) a pozná v nich akordy z akordů písničky.

Použití: python helper/interludes.py <složka se stopami> song.json sync.json vystup.json
"""

import json, subprocess, sys
import numpy as np

SR = 22050
HOP = 0.1  # s
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def load(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32)


def rms_env(x):
    hop = int(SR * HOP)
    n = len(x) // hop
    return np.sqrt((x[:n * hop].reshape(n, hop) ** 2).mean(1))


def chroma(x):
    N = 8192
    hop = int(SR * HOP)
    win = np.hanning(N).astype(np.float32)
    freqs = np.fft.rfftfreq(N, 1 / SR)
    sel = (freqs > 60) & (freqs < 1000)
    pc = (np.round(12 * np.log2(freqs[sel] / 440.0)) + 9) % 12
    pc = pc.astype(int)
    frames = []
    for s in range(0, len(x) - N, hop):
        mag = np.abs(np.fft.rfft(x[s:s + N] * win))[sel]
        c = np.bincount(pc, weights=mag ** 2, minlength=12)   # energie po tónech (basa = kořen akordu)
        frames.append(np.sqrt(c))
    C = np.array(frames)
    # pad začátek, aby rámec i odpovídal času i*HOP (střed okna)
    pad = int((N / 2) / hop)
    C = np.vstack([np.repeat(C[:1], pad, 0), C])
    C = C / (np.linalg.norm(C, axis=1, keepdims=True) + 1e-9)
    return C


def template(root, minor):
    t = np.zeros(12)
    t[root % 12] = 1.0
    t[(root + (3 if minor else 4)) % 12] = 0.45
    t[(root + 7) % 12] = 0.55
    return t / np.linalg.norm(t)


def viterbi(scores, stay=0.0, switch=-0.35):
    T, K = scores.shape
    dp = scores[0].copy()
    back = np.zeros((T, K), int)
    for t in range(1, T):
        trans = dp[:, None] + np.where(np.eye(K, dtype=bool), stay, switch)
        back[t] = trans.argmax(0)
        dp = trans.max(0) + scores[t]
    path = [int(dp.argmax())]
    for t in range(T - 1, 0, -1):
        path.append(back[t][path[-1]])
    return path[::-1]


def segments(path, t0):
    out = []
    for i, k in enumerate(path):
        if out and out[-1][0] == k:
            out[-1][2] = t0 + (i + 1) * HOP
        else:
            out.append([k, t0 + i * HOP, t0 + (i + 1) * HOP])
    return out


def main():
    stems, song_path, sync_path = sys.argv[1:4]
    song = json.load(open(song_path, encoding='utf8'))
    sync = json.load(open(sync_path, encoding='utf8'))
    voc = load(stems + '/vocals.mp3')
    inst = load(stems + '/no_vocals.mp3')
    dur = len(inst) / SR

    # akordy písničky (tak, jak jsou v songu)
    chords = {}
    for l in song['lines']:
        for c in l['chords']:
            chords[(c['root'], c.get('q') or '')] = c
    cand = sorted(chords)
    print('akordy písničky:', [NAMES[r] + q for r, q in cand])

    C = chroma(inst)
    T = len(C)

    # posun mezi zapsanými akordy a nahrávkou: kde šablony nejlíp sedí
    best = None
    for sh in range(12):
        tm = np.array([template(r + sh, q.startswith('m')) for r, q in cand])
        s = (C @ tm.T).max(1).mean()
        if best is None or s > best[1]:
            best = (sh, s)
    shift = best[0]
    print('posun nahrávka vs. zápis: %+d půltónů' % ((shift + 6) % 12 - 6))
    tm = np.array([template(r + shift, q.startswith('m')) for r, q in cand])
    scores = C @ tm.T

    # kontrola přesnosti na zpívaných částech: známé akordy a jejich časy
    known = []
    for li, l in enumerate(song['lines']):
        sl = sync['lines'][li] if li < len(sync['lines']) else {'c': []}
        tmap = {p: t for p, t in sl['c']}
        for c in l['chords']:
            if c['pos'] in tmap:
                known.append((tmap[c['pos']], (c['root'], c.get('q') or '')))
    known.sort()
    path_all = viterbi(scores)
    hit = 0
    for i, (t, ch) in enumerate(known):
        t1 = known[i + 1][0] if i + 1 < len(known) else t + 2
        a, b = int((t + 0.2) / HOP), int(min(t1, t + 2) / HOP)
        if b <= a or b >= T:
            continue
        seg = path_all[a:b]
        guess = cand[max(set(seg), key=seg.count)]
        hit += guess == ch
    print('přesnost na zpívaných částech: %d / %d' % (hit, len(known)))

    # místa bez zpěvu: mezi řádky s časy, delší než 4 s (+ začátek a konec)
    spans = []
    for l in sync['lines']:
        if l['w']:
            spans.append((l['w'][0][2], l['w'][-1][3]))
    spans.sort()
    gaps = []
    prev_end = 0.0
    for s, e in spans:
        if s - prev_end > 4:
            gaps.append((prev_end, s))
        prev_end = max(prev_end, e)
    if dur - prev_end > 4:
        gaps.append((prev_end, dur))

    # mezery podle vokálu: souvislé ticho ve stopě zpěvu delší než 4 s
    venv = rms_env(voc)
    thr = np.percentile(venv, 60) * 0.35
    k = int(0.6 / HOP)
    sm = np.array([venv[max(0, i - k):i + k + 1].max() for i in range(len(venv))])   # krátké nádechy nepočítat
    quiet_v = sm < thr
    vgaps, i = [], 0
    while i < len(quiet_v):
        if quiet_v[i]:
            j = i
            while j < len(quiet_v) and quiet_v[j]:
                j += 1
            if (j - i) * HOP >= 4:
                vgaps.append((i * HOP, j * HOP))
            i = j
        else:
            i += 1
    print('ticho ve vokálu:', [(round(a, 1), round(b, 1)) for a, b in vgaps])
    gaps = [(a, min(b, dur)) for a, b in vgaps]
    result = []
    for g0, g1 in gaps:
        a, b = int(g0 / HOP), int(min(g1, dur) / HOP)
        quiet = (venv[a:b] < thr).mean()
        sub = viterbi(scores[a:b])
        segs = [s for s in segments(sub, a * HOP) if s[2] - s[1] >= 0.8]
        # sloučit sousední stejné po vyhození krátkých
        merged = []
        for s in segs:
            if merged and merged[-1][0] == s[0]:
                merged[-1][2] = s[2]
            else:
                merged.append(list(s))
        # ticho na konci (doznění)
        inst_env = rms_env(inst)[a:b]
        loud = inst_env > np.percentile(rms_env(inst), 20)
        music_until = round(a * HOP + (np.where(loud)[0][-1] + 1) * HOP, 2) if loud.any() else g1
        result.append({
            'from': round(g0, 2), 'to': round(g1, 2), 'quiet': round(float(quiet), 2),
            'chords': [{'chord': NAMES[cand[k][0]] + cand[k][1], 'root': cand[k][0], 'q': cand[k][1],
                        'start': round(s1, 2), 'end': round(s2, 2)} for k, s1, s2 in merged
                       if s1 < music_until - 0.5],   # doznění na konci nepočítat
            'music_until': music_until,
        })
    for r in result:
        print('\nmezera %.1f–%.1f s (bez zpěvu %d %%), hudba do %s' % (r['from'], r['to'], r['quiet'] * 100, r['music_until']))
        print('  ' + '  '.join('%s@%.1f' % (c['chord'], c['start']) for c in r['chords']))
    json.dump({'shift': shift, 'gaps': result}, open(sys.argv[4], 'w', encoding='utf8'), ensure_ascii=False, indent=1)


if __name__ == '__main__':
    main()
