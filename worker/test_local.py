"""Lokální test kroků 3–4 (doby + akordy) bez GPU: vezme slova z existujícího sync a stopy z helper/tmp/stems.

python worker/test_local.py <song.json z REST (pole s {data})> <složka se stopami>
Porovná nové časy akordů se stávajícími v databázi.
"""
import json, sys, time
import numpy as np
sys.path.insert(0, __file__.rsplit('\\', 1)[0].rsplit('/', 1)[0])
from pipeline import compute_sync

song = json.load(open(sys.argv[1], encoding='utf-8'))[0]['data']
stems = sys.argv[2]
lines = song['lines']
old = song['sync']['lines']
words = [l.get('w') or [] for l in old]
t0 = time.time()
sync, stats, beats = compute_sync(lines, stems + '/vocals.mp3', stems + '/no_vocals.mp3', words=words)
print('čas %.1f s' % (time.time() - t0), stats)

diffs, free = [], []
for li, (a, b) in enumerate(zip(old, sync['lines'])):
    om = {p: t for p, t in (a.get('c') or [])}
    for p, t in b['c']:
        if p in om:
            d = t - om[p]
            (free if not lines[li]['text'].strip() else diffs).append((li, p, om[p], t, d))
for name, arr in (('zpívané', diffs), ('bez textu', free)):
    if not arr:
        continue
    d = np.abs([x[4] for x in arr])
    print('%s: %d akordů, medián |rozdíl| %.2f s, do 0.3 s: %d, >1 s: %d' % (name, len(arr), np.median(d), (d <= 0.3).sum(), (d > 1).sum()))
    for li, p, o, n, dd in arr:
        if abs(dd) > 0.3:
            print('   ř.%2d pos %3d  DB %6.2f  nový %6.2f  (%+.2f)  %s' % (li, p, o, n, dd, lines[li]['text'][:30]))
