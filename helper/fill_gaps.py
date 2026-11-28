"""playalong.cz – doplní chybějící intro / mezihry / outro (místa bez zpěvu, kde text nemá akordy).

Akordy pozná ze stopy bez vokálu (helper/tmp/stems/<id>/no_vocals.mp3): chroma po dobách (sync.beats),
šablony jen z akordů písničky, Viterbi. Přesnost si nejdřív ověří na zpívaných částech (známé akordy a časy).
Místa bez zpěvu bere z časů slov a akordů v song.sync; tam, kde už je řádek s akordy s časy, nic nepřidává.

Režim --full (písničky jen s textem): akordy pozná pro celou písničku z akordů tóniny nahrávky
a nad slova je přidá tam, kde se akord mění.

Použití:
  python helper/fill_gaps.py <id> [<id> …]            → jen ukáže, co by přidal (nic neukládá)
  python helper/fill_gaps.py <id> … --write           → záloha do helper/tmp/zalohy/ a uložení do databáze
  python helper/fill_gaps.py <id> --full [--write]    → akordy pro celou písničku (song bez akordů)
  volitelně --no-outro (konec nedoplňovat), --min-acc 65 (pod tuhle přesnost na zpívaných částech nic nepřidá)

Vypisuje jen čísla, názvy částí a akordy – žádný text písní.
"""
import json, re, sys, time, os, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from interludes import load, chroma, rms_env, viterbi, SR, HOP  # noqa: E402

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
ROOT = os.path.dirname(HERE)
GAP = 5.0          # s bez zpěvu na začátku / na konci = intro / outro
GAP_SEC = 7.0      # mezihra mezi částmi (další řádek začíná novou částí)
GAP_MID = 12.0     # mezihra uprostřed části
MAX_PER_LINE = 8   # akordů na řádek

args = sys.argv[1:]
WRITE = '--write' in args
FULL = '--full' in args
NO_OUTRO = '--no-outro' in args   # konec bez zpěvu nedoplňovat (např. text nemá všechna opakování)
MIN_ACC = float(args[args.index('--min-acc') + 1]) if '--min-acc' in args else 65.0
IDS = [a for i, a in enumerate(args) if not a.startswith('--') and (i == 0 or args[i - 1] != '--min-acc')]

sec = json.load(open(os.path.join(HERE, 'secrets.json')))
cfg = open(os.path.join(ROOT, 'config.js'), encoding='utf-8').read()
URL = re.search(r"supabaseUrl:\s*'([^']+)'", cfg).group(1) + '/rest/v1/'
H = {'apikey': sec['supabase_secret'], 'Authorization': 'Bearer ' + sec['supabase_secret'], 'Content-Type': 'application/json'}


def api(path, data=None, method='GET'):
    req = urllib.request.Request(URL + path, headers=H, method=method,
                                 data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else None


def name(r, q):
    return NAMES[r % 12] + (q or '')


def is_minor(q):
    q = q or ''
    return q.startswith('m') and not q.startswith('maj')


def tmpl(r, q):
    t = np.zeros(12)
    t[r % 12] = 1.0
    t[(r + (3 if is_minor(q) else 4)) % 12] = 0.45
    t[(r + 7) % 12] = 0.55
    if '7' in (q or ''):
        t[(r + (11 if 'maj' in q else 10)) % 12] = 0.3
    if 'sus4' in (q or ''):
        t[(r + 4) % 12] = 0; t[(r + 3) % 12] = 0; t[(r + 5) % 12] = 0.45
    if 'sus2' in (q or ''):
        t[(r + 4) % 12] = 0; t[(r + 3) % 12] = 0; t[(r + 2) % 12] = 0.45
    return t / np.linalg.norm(t)


def beat_grid(sync, dur):
    b = [x for x in (sync.get('beats') or []) if 0 <= x <= dur]
    if len(b) < 8:
        b = list(np.arange(0, dur, 0.5))
    b = sorted(b)
    # doplnit doby před první a za poslední (stejný rozestup), ať jde pokrýt i intro / konec
    p = float(np.median(np.diff(b)))
    while b[0] - p > 0:
        b.insert(0, b[0] - p)
    while b[-1] + p < dur:
        b.append(b[-1] + p)
    return np.array(b), p


def beat_chroma(C, beats):
    out = []
    for a, b in zip(beats, list(beats[1:]) + [beats[-1] + (beats[-1] - beats[-2])]):
        i, j = int(a / HOP), max(int(a / HOP) + 1, int(b / HOP))
        seg = C[i:j] if i < len(C) else C[-1:]
        v = seg.mean(0) if len(seg) else np.zeros(12)
        out.append(v / (np.linalg.norm(v) + 1e-9))
    return np.array(out)


def segments_from(path, beats_idx):
    segs = []
    for k, bi in zip(path, beats_idx):
        if segs and segs[-1][0] == k:
            segs[-1][2] = bi + 1
        else:
            segs.append([k, bi, bi + 1])
    return segs


def clean(segs, min_beats=2):
    """krátké úseky (< min_beats dob) přilepit k sousedovi, pak sloučit stejné"""
    changed = True
    while changed and len(segs) > 1:
        changed = False
        for i, s in enumerate(segs):
            if s[2] - s[1] < min_beats:
                if i > 0:
                    segs[i - 1][2] = s[2]
                else:
                    segs[i + 1][1] = s[1]
                segs.pop(i)
                changed = True
                break
    out = []
    for s in segs:
        if out and out[-1][0] == s[0]:
            out[-1][2] = s[2]
        else:
            out.append(list(s))
    return out


def chord_line(chs):
    """řádek bez textu: akordy za sebou (pozice podle délky názvu)"""
    pos, line, c = 0, [], []
    for (r, q), t in chs:
        line.append({'pos': pos, 'root': r, 'q': q, 'bass': None})
        c.append([pos, round(float(t), 2)])
        pos += len(name(r, q)) + 2
    return line, c


def process(sid):
    song = api(f'songs?select=id,title,artist,data,approved&id=eq.{sid}')[0]
    d = song['data']
    L, S = d['lines'], d.get('sync') or {}
    SL = S.get('lines') or []
    stems = os.path.join(HERE, 'tmp', 'stems', sid)
    print(f"\n== {sid} {song['artist']} – {song['title']}")
    if not SL or not os.path.exists(os.path.join(stems, 'no_vocals.mp3')):
        print('  chybí časy nebo stopy – přeskakuju'); return
    inst = load(os.path.join(stems, 'no_vocals.mp3'))
    dur = len(inst) / SR
    C = chroma(inst)
    beats, period = beat_grid(S, dur)
    BC = beat_chroma(C, beats)
    env = rms_env(inst)
    loud_thr = np.percentile(env, 20)
    loud_t = np.where(env > loud_thr)[0]
    music_from = loud_t[0] * HOP if len(loud_t) else 0.0
    music_until = (loud_t[-1] + 1) * HOP if len(loud_t) else dur

    # kandidáti: akordy písničky (v --full akordy tóniny nahrávky)
    known = []   # (čas, (root, q))
    cand = sorted({(c['root'], c.get('q') or '') for l in L for c in l['chords']})
    for li, l in enumerate(L):
        tmap = {p: t for p, t in ((SL[li] if li < len(SL) else {}).get('c') or [])}
        for c in l['chords']:
            if c['pos'] in tmap:
                known.append((tmap[c['pos']], (c['root'], c.get('q') or '')))
    known.sort()
    if FULL:
        prof_maj = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        prof_min = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        tot = C.sum(0)
        best = max(((np.corrcoef(tot, np.roll(p, k))[0, 1], k, m) for k in range(12) for m, p in ((False, prof_maj), (True, prof_min))))
        _, kr, km = best
        tonic = (kr + 3) % 12 if km else kr   # paralelní dur
        cand = [(tonic, ''), ((tonic + 2) % 12, 'm'), ((tonic + 4) % 12, 'm'), ((tonic + 5) % 12, ''), ((tonic + 7) % 12, ''), ((tonic + 9) % 12, 'm')]
        print(f"  tónina nahrávky: {name(kr, 'm' if km else '')}, akordy: {[name(*c) for c in cand]}")
    if not cand:
        print('  písnička nemá akordy (zkus --full)'); return
    TM = np.array([tmpl(r, q) for r, q in cand])
    scores = BC @ TM.T

    # přesnost na zpívaných částech (akord v době, kdy podle časů zní)
    path_all = viterbi(scores, switch=-0.25)
    hit = tot = 0
    for i, (t, ch) in enumerate(known):
        if ch not in cand: continue
        t1 = known[i + 1][0] if i + 1 < len(known) else t + 2 * period
        a = int(np.searchsorted(beats, t + 0.05)); b = int(np.searchsorted(beats, min(t1, t + 4 * period)))
        if b <= a: continue
        seg = path_all[a:b]
        tot += 1; hit += cand[max(set(seg), key=seg.count)] == ch
    acc = 100 * hit / tot if tot else None
    print(f"  doby {len(beats)} (≈{60 / period:.0f} BPM) | přesnost na zpívaných {hit}/{tot}" + (f" = {acc:.0f} %" if acc is not None else ''))

    # --full: akordy nad slova zpívaných řádků
    newL = [dict(l, chords=list(l['chords'])) for l in L]
    newSL = [dict(SL[i]) if i < len(SL) else {'w': [], 'c': []} for i in range(len(L))]
    if FULL:
        segs = clean(segments_from(path_all, range(len(beats))), 2)
        changes = [(beats[s[1]], cand[s[0]]) for s in segs]
        added = 0
        for li, l in enumerate(newL):
            ws = [w for w in (newSL[li].get('w') or []) if w[2] is not None]
            if not ws or l['chords']: continue
            t0, t1 = ws[0][2], ws[-1][3]
            cur = [c for c in changes if c[0] <= t0]
            here = ([(t0, cur[-1][1])] if cur else []) + [c for c in changes if t0 < c[0] < t1 - 0.3]
            ch, cc, used = [], [], set()
            for t, k in here:
                w = min(ws, key=lambda w: abs(w[2] - t))
                if w[0] in used or (ch and (ch[-1]['root'], ch[-1]['q']) == k): continue
                used.add(w[0]); ch.append({'pos': w[0], 'root': k[0], 'q': k[1], 'bass': None}); cc.append([w[0], round(float(max(t, t0 - 0.3) if t < t0 else t), 2)])
            l['chords'] = ch; newSL[li]['c'] = cc; added += len(ch)
        print(f"  nad slova přidáno akordů: {added}")
        acc = acc if acc is not None else 100.0
    elif acc is not None and acc < MIN_ACC:
        print(f"  přesnost pod {MIN_ACC:.0f} % – nic nepřidávám"); return

    # pokryté časy: slova + akordy s časy
    def items(i):
        sl = newSL[i]
        ws = [(w[2], w[3]) for w in (sl.get('w') or []) if w[2] is not None]
        cs = [(t, t) for _, t in (sl.get('c') or [])]
        return ws + cs
    timed = [(i, min(a for a, _ in it), max(b for _, b in it)) for i in range(len(newL)) if (it := items(i))]
    gaps = []   # (vložit před řádek index, od, do, druh)
    if timed and timed[0][1] - music_from > GAP:
        gaps.append((0, music_from, timed[0][1] - 0.15, 'intro'))
    prev_end = timed[0][2] if timed else 0
    for (i0, s0, e0), (i1, s1, e1) in zip(timed, timed[1:]):
        prev_end = max(prev_end, e0)
        between = range(i0 + 1, i1)
        at = next((k for k in between if newL[k].get('section')), i1)
        boundary = bool(newL[at].get('section'))
        untimed = any(newL[k]['chords'] for k in between)   # akordy bez časů už tam jsou
        if not untimed and s1 - prev_end > (GAP_SEC if boundary else GAP_MID):
            gaps.append((at, prev_end + 0.4, s1 - 0.15, 'inter'))
        prev_end = max(prev_end, e1)
    if timed and not NO_OUTRO and music_until - prev_end > GAP:
        gaps.append((len(newL), prev_end + 0.4, music_until - 0.3, 'outro'))

    inserts = []
    for at, t0, t1, kind in gaps:
        a = int(np.searchsorted(beats, t0)); b = int(np.searchsorted(beats, t1))
        if b - a < 4: continue
        sub = viterbi(scores[a:b], switch=-0.35)
        segs = clean(segments_from(sub, range(a, b)), 2)
        chs = [(cand[s[0]], beats[s[1]]) for s in segs if beats[s[1]] < music_until - 0.5]
        if not chs: continue
        lines = [chs[k:k + MAX_PER_LINE] for k in range(0, len(chs), MAX_PER_LINE)]
        inserts.append((at, kind, lines))
        print(f"  + {kind:5} {t0:6.1f}–{t1:6.1f} s  před ř.{at:>2}: " + ' | '.join(' '.join(f"{name(*k)}@{t:.1f}" for k, t in ln) for ln in lines))
    if not inserts and not FULL:
        print('  nic k doplnění'); return

    # vložit odzadu, ať sedí indexy; sekci následujícího řádku zachovat
    def section_at(i):
        for k in range(min(i, len(newL) - 1), -1, -1):
            if newL[k].get('section'): return newL[k]['section']
        return None
    for at, kind, lines in sorted(inserts, key=lambda x: -x[0]):
        if at < len(newL) and not newL[at].get('section'):
            newL[at]['section'] = section_at(at)
        new_lines, new_sl = [], []
        for n, ln in enumerate(lines):
            ch, cc = chord_line(ln)
            new_lines.append({'text': '', 'section': kind if n == 0 else None, 'chords': ch})
            new_sl.append({'w': [], 'c': cc})
        newL[at:at] = new_lines
        newSL[at:at] = new_sl

    if not WRITE:
        print('  (jen náhled – pro uložení --write)'); return
    os.makedirs(os.path.join(HERE, 'tmp', 'zalohy'), exist_ok=True)
    bk = os.path.join(HERE, 'tmp', 'zalohy', f"{sid}-pred-fill-{time.strftime('%Y%m%d-%H%M%S')}.json")
    json.dump(song, open(bk, 'w', encoding='utf-8'), ensure_ascii=False)
    d2 = dict(d, lines=newL, sync=dict(S, lines=newSL))
    api(f'songs?id=eq.{sid}', {'data': d2}, 'PATCH')
    print(f'  ✓ uloženo (záloha {os.path.basename(bk)})')


for sid in IDS:
    try:
        process(sid)
    except Exception as e:
        print(f'  CHYBA {sid}: {e!r}')
