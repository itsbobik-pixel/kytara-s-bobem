"""playalong.cz – přicvakne akordy ve zpívaných částech na doby podle hudby.

Postup: sleduje doby ve stopě bez vokálu (onset + dynamické sledování tempa), pak segmentovým DP
přiřadí každý akord (pořadí z textu písně) době v okně −4,5 … +2,2 doby kolem jeho slova; rozhoduje
chroma shoda se šablonou akordu, malá penalizace za vzdálenost od slova.

ZATÍM NAPSANÉ PRO TETOVACÍ: cesta ke stopám je natvrdo (STEMS), vstupy song_now.json a sync_now.json
(data.lines a data.sync z databáze) se čtou z aktuální složky, výstup snap.json. Spouštět ze složky,
kde je i helper/interludes.py (importuje z něj). Výsledné časy se pak zapisují do song.sync.lines[li].c.
"""
import json, sys
import numpy as np
from interludes import load, chroma, template, HOP, NAMES, SR

STEMS = 'C:/Kytara s Bobem/helper/tmp/stems/4cfugwqevdk5'
inst = load(STEMS + '/no_vocals.mp3')
dur = len(inst) / SR
song = json.load(open('song_now.json', encoding='utf8'))
sync = json.load(open('sync_now.json'))

# ---------- 1) doby: onset síla + dynamické sledování (tempo ~0.546 s) ----------
OH = 0.01
N, hop = 2048, int(SR * OH)
win = np.hanning(N)
prev, env = None, []
for s in range(0, len(inst) - N, hop):
    m = np.log1p(np.abs(np.fft.rfft(inst[s:s + N] * win))[:400])   # do ~4 kHz
    env.append(0.0 if prev is None else float(np.maximum(m - prev, 0).sum()))
    prev = m
env = np.array(env)
env = (env - env.mean()) / (env.std() + 1e-9)
P = 0.546 / OH
T = len(env)
score = env.copy()
back = np.full(T, -1)
lo, hi = int(P * 0.75), int(P * 1.33)
for t in range(hi, T):
    taus = np.arange(t - hi, t - lo + 1)
    pen = -6.0 * np.log((t - taus) / P) ** 2
    cand = score[taus] + pen
    k = cand.argmax()
    score[t] = env[t] + cand[k]
    back[t] = taus[k]
t = int(np.argmax(score[-int(P):])) + T - int(P)
beats = []
while t >= 0:
    beats.append(t * OH)
    t = back[t]
beats = np.array(beats[::-1])
ib = np.diff(beats)
print('dob: %d, průměrná doba %.3f s (min %.3f, max %.3f)' % (len(beats), ib.mean(), ib.min(), ib.max()))

# ---------- 2) akordy z textu s jejich současnými časy ----------
C = chroma(inst)
csum = None
types = {}
items = []   # (li, pos, root, q, t_text)
for li, l in enumerate(song['lines']):
    sl = sync['lines'][li]
    tmap = {p: t for p, t in sl['c']}
    for c in sorted(l['chords'], key=lambda c: c['pos']):
        t_text = tmap.get(c['pos'])
        if t_text is None and sl['w']:
            t_text = sl['w'][0][2]
        if t_text is None:
            continue
        key = (c['root'], c.get('q') or '')
        types.setdefault(key, len(types))
        items.append((li, c['pos'], key, float(t_text)))
items.sort(key=lambda x: x[3])
K = len(items)
tm = np.array([template(r, q.startswith('m') and not q.startswith('maj')) for r, q in types])
S = C @ tm.T                                  # rámce × typ akordu
cs = np.vstack([np.zeros((1, S.shape[1])), np.cumsum(S, 0)])
fr = lambda t: int(min(len(S), max(0, round(t / HOP))))
seg = lambda typ, a, b: cs[fr(b), typ] - cs[fr(a), typ]

# ---------- 3) segmentové DP: každý akord začíná na nějaké době poblíž svého slova ----------
beat_len = ib.mean()
EARLY, LATE = 4.5, 2.2              # okno v dobách (dřív: klidně z konce předchozího řádku)
LAMBDA = 0.35                       # cena za každou dobu odchylky od slova (nad půl doby)
cands = []
for li, pos, key, tt in items:
    j = np.where((beats >= tt - EARLY * beat_len) & (beats <= tt + LATE * beat_len))[0]
    if len(j) == 0:
        j = np.array([int(np.abs(beats - tt).argmin())])
    cands.append(j)
prior = lambda k, j: -LAMBDA * max(0.0, abs(beats[j] - items[k][3]) / beat_len - 0.5)
dp = [dict() for _ in range(K)]
bk = [dict() for _ in range(K)]
for j in cands[0]:
    dp[0][j] = prior(0, j)
for k in range(1, K):
    typ_prev = types[items[k - 1][2]]
    for j in cands[k]:
        best, arg = -1e18, None
        for jp, v in dp[k - 1].items():
            if jp >= j or j - jp > 40:
                continue
            s = v + seg(typ_prev, beats[jp], beats[j])
            if s > best:
                best, arg = s, jp
        if arg is not None:
            dp[k][j] = best + prior(k, j)
            bk[k][j] = arg
# konec: poslední akord hraje do konce hudby
last_typ = types[items[-1][2]]
end = min(dur, items[-1][3] + 6)
jbest = max(dp[-1], key=lambda j: dp[-1][j] + seg(last_typ, beats[j], end))
assign = [0] * K
assign[-1] = jbest
for k in range(K - 1, 0, -1):
    assign[k - 1] = bk[k][assign[k]]

res = []
for (li, pos, key, tt), j in zip(items, assign):
    res.append({'li': li, 'pos': pos, 'chord': NAMES[key[0]] + key[1], 'old': round(tt, 2), 'new': round(float(beats[j]), 2)})
moves = [r['new'] - r['old'] for r in res]
print('akordů %d, posun: medián %.2f s, |posun|>0.4 s: %d, >1 s: %d' % (K, np.median(moves), sum(abs(m) > 0.4 for m in moves), sum(abs(m) > 1 for m in moves)))
for r in res:
    d = r['new'] - r['old']
    if abs(d) > 0.4:
        text = song['lines'][r['li']]['text'][:34] or '(mezihra)'
        print('  ř.%2d %-4s %6.2f -> %6.2f (%+.2f s = %+.1f dob)  %s' % (r['li'], r['chord'], r['old'], r['new'], d, d / beat_len, text))
json.dump({'beats': [round(b, 3) for b in beats.tolist()], 'chords': res}, open('snap.json', 'w'), indent=1)
