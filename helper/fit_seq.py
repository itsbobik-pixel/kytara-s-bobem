"""playalong.cz – napasuje ZNÁMÉ pořadí akordů (např. mezihru F# C# D#m A#m B F# C#) na nahrávku
(levo-pravé zarovnání s minimální délkou akordu) + odhad tempa a délky akordů v dobách.

ZATÍM NAPSANÉ PRO TETOVACÍ: cesta ke stopám, akordy (ID) a okna meziher jsou natvrdo; výstup fits.json.
Pro mezihry se nakonec použila pravidelná mřížka dob podle rozpisu uživatele (2-2-2-2-2-2-4).
"""
import json, sys
import numpy as np
from interludes import load, chroma, template, viterbi, segments, rms_env, HOP, NAMES, SR

STEMS = 'C:/Kytara s Bobem/helper/tmp/stems/4cfugwqevdk5'
inst = load(STEMS + '/no_vocals.mp3')
C = chroma(inst)
ID = {'C#': (1, ''), 'D#m': (3, 'm'), 'F#': (6, ''), 'A#m': (10, 'm'), 'B': (11, '')}
names = list(ID)
tm = np.array([template(ID[n][0], ID[n][1] == 'm') for n in names])
S = C @ tm.T


def tempo():
    # onset síla: kladný spektrální rozdíl, hop 10 ms
    N, hop = 2048, int(SR * 0.01)
    win = np.hanning(N)
    prev, env = None, []
    for s in range(0, len(inst) - N, hop):
        m = np.log1p(np.abs(np.fft.rfft(inst[s:s + N] * win)))
        env.append(0 if prev is None else np.maximum(m - prev, 0).sum())
        prev = m
    env = np.array(env); env -= env.mean()
    ac = np.correlate(env, env, 'full')[len(env) - 1:]
    lags = np.arange(len(ac)) * 0.01
    ok = (lags > 60 / 200) & (lags < 60 / 60)
    lag = lags[ok][ac[ok].argmax()]
    return 60 / lag


def fit(seq, t0, t1, mindur=0.3):
    """levo-pravé zarovnání: stav i = i-tý akord sekvence; každý trvá aspoň mindur"""
    a, b = int(t0 / HOP), int(t1 / HOP)
    sc = S[a:b]
    T, K = len(sc), len(seq)
    m = max(1, int(mindur / HOP))
    idx = [names.index(x) for x in seq]
    # rozšířené stavy: (akord k, podstav 0..m-1 = vynucená minimální délka)
    NS = K * m
    neg = -1e9
    dp = np.full(NS, neg); dp[0] = sc[0, idx[0]]
    back = np.zeros((T, NS), int)
    for t in range(1, T):
        new = np.full(NS, neg); bk = np.zeros(NS, int)
        for s in range(NS):
            k, j = divmod(s, m)
            cands = []
            if j == m - 1:
                cands.append((dp[s], s))                 # zůstat (po splnění min. délky)
            if j > 0:
                cands.append((dp[s - 1], s - 1))         # pokračovat v min. délce
            elif k > 0:
                cands.append((dp[s - 1], s - 1))         # přechod z konce předchozího akordu
            if not cands:
                continue
            v, src = max(cands)
            new[s] = v + sc[t, idx[k]]; bk[s] = src
        dp, back[t] = new, bk
    s = NS - 1
    path = [s]
    for t in range(T - 1, 0, -1):
        s = back[t][s]; path.append(s)
    path = path[::-1]
    starts = []
    for t, s in enumerate(path):
        k = s // m
        if len(starts) <= k:
            starts.append(t0 + t * HOP)
    score = sum(sc[t, idx[s // m]] for t, s in enumerate(path)) / T
    free = sc.max(1).mean()
    return starts, score, free


bpm = tempo()
beat = 60 / bpm
print('tempo ~ %.1f BPM (doba %.2f s)' % (bpm, beat))
P = ['F#', 'C#', 'D#m', 'A#m', 'B', 'F#', 'C#']
windows = {'mezihra 1': (15.4, 33.2), 'mezihra 2': (85.5, 103.0), 'outro': (191.5, 210.3)}
out = {}
for name, (t0, t1) in windows.items():
    best = None
    for label, seq in [('1×', P), ('2×', P + P), ('2× + F#', P + P + ['F#'])]:
        st, sc, free = fit(seq, t0, t1)
        print('%-10s %-8s shoda %.3f (volné rozpoznání %.3f)' % (name, label, sc, free))
        if best is None or sc > best[1] + 0.005:
            best = (label, sc, seq, st)
    label, sc, seq, st = best
    ends = st[1:] + [t1]
    print('  => %s:' % label, '  '.join('%s@%.1f(%.1f dob)' % (c, s, (e - s) / beat) for c, s, e in zip(seq, st, ends)))
    out[name] = {'seq': seq, 'starts': [round(x, 2) for x in st]}
json.dump({'bpm': bpm, 'fits': out}, open('fits.json', 'w'), indent=1)
