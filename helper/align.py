"""Kytara s Bobem – zarovnání textu písničky k nahrávce.

Postup:
  1. Demucs oddělí vokál a doprovod (vocals.wav, no_vocals.wav).
  2. WhisperX přepíše vokál a zarovná slova (časy každého slova).
  3. Naše slova (z textu písničky) se namapují na přepsaná slova
     (Needleman-Wunsch s podobností slov), chybějící časy se dopočítají.
  4. Akordy dostanou čas podle pozice v řádku.

Použití: python align.py audio.mp3 song.json out.json [--lang cs]
song.json = {"lines": [{"text": "...", "chords": [{"pos": 3, ...}], "section": ...}]}
"""
import json
import os
import re
import subprocess
import sys
import unicodedata
from difflib import SequenceMatcher


def norm(w):
    w = unicodedata.normalize('NFD', w.lower())
    w = ''.join(c for c in w if unicodedata.category(c) != 'Mn')
    return re.sub(r'[^a-z0-9]', '', w)


def separate(audio, outdir):
    subprocess.run([sys.executable, '-m', 'demucs', '--two-stems=vocals', '-n', 'htdemucs',
                    '-o', outdir, audio], check=True)
    base = os.path.splitext(os.path.basename(audio))[0]
    d = os.path.join(outdir, 'htdemucs', base)
    return os.path.join(d, 'vocals.wav'), os.path.join(d, 'no_vocals.wav')


def transcribe(vocals, lang, prompt):
    import whisperx
    dev = 'cuda'
    model = whisperx.load_model('large-v3', dev, compute_type='float16', language=lang,
                                asr_options={'initial_prompt': prompt[:800]})
    audio = whisperx.load_audio(vocals)
    res = model.transcribe(audio, batch_size=8, language=lang)
    amodel, meta = whisperx.load_align_model(language_code=lang, device=dev)
    res = whisperx.align(res['segments'], amodel, meta, audio, dev, return_char_alignments=False)
    words = []
    for seg in res['segments']:
        for w in seg.get('words', []):
            if 'start' in w and norm(w['word']):
                words.append({'w': w['word'], 'n': norm(w['word']), 'start': w['start'], 'end': w['end']})
    return words


def our_words(lines):
    out = []
    for li, l in enumerate(lines):
        for m in re.finditer(r'\S+', l['text']):
            n = norm(m.group())
            if n:
                out.append({'line': li, 'pos': m.start(), 'len': len(m.group()), 'n': n})
    return out


def sim(a, b):
    if a == b:
        return 1.0
    return SequenceMatcher(None, a, b).ratio()


def match(ours, theirs):
    """Globální zarovnání (Needleman-Wunsch). Vrací ours[i]['t'] = index do theirs nebo None."""
    n, m = len(ours), len(theirs)
    GAP = -0.4
    score = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        score[i][0] = i * GAP; back[i][0] = 1
    for j in range(1, m + 1):
        score[0][j] = j * GAP * 0.5; back[0][j] = 2   # přebytečná slova v přepisu jsou levnější
    for i in range(1, n + 1):
        a = ours[i - 1]['n']
        for j in range(1, m + 1):
            s = sim(a, theirs[j - 1]['n'])
            d = score[i - 1][j - 1] + (s * 2 - 1 if s >= 0.5 else -1.0)
            u = score[i - 1][j] + GAP
            l = score[i][j - 1] + GAP * 0.5
            if d >= u and d >= l:
                score[i][j] = d; back[i][j] = 0
            elif u >= l:
                score[i][j] = u; back[i][j] = 1
            else:
                score[i][j] = l; back[i][j] = 2
    i, j = n, m
    for o in ours:
        o['t'] = None
    while i > 0 and j > 0:
        b = back[i][j]
        if b == 0:
            if sim(ours[i - 1]['n'], theirs[j - 1]['n']) >= 0.5:
                ours[i - 1]['t'] = j - 1
            i -= 1; j -= 1
        elif b == 1:
            i -= 1
        else:
            j -= 1


def fill_times(ours, theirs):
    for o in ours:
        if o['t'] is not None:
            o['start'] = theirs[o['t']]['start']; o['end'] = theirs[o['t']]['end']; o['ok'] = True
        else:
            o['start'] = o['end'] = None; o['ok'] = False
    # dopočítat chybějící lineárně mezi známými sousedy
    known = [k for k, o in enumerate(ours) if o['ok']]
    if not known:
        return
    for k, o in enumerate(ours):
        if o['ok']:
            continue
        prev = max((x for x in known if x < k), default=None)
        nxt = min((x for x in known if x > k), default=None)
        # mezi řádky bývá mezihra → nepřiřazené slovo drž u souseda ze stejného řádku
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


def build(lines, ours, duration):
    out_lines = []
    for li, l in enumerate(lines):
        ws = [o for o in ours if o['line'] == li]
        words = [{'pos': o['pos'], 'len': o['len'], 'start': round(o['start'], 3),
                  'end': round(o['end'], 3), 'ok': o['ok']} for o in ws]

        def t_at(pos):
            if not words:
                return None
            if pos <= words[0]['pos']:
                return words[0]['start']
            for k, w in enumerate(words):
                if w['pos'] <= pos < w['pos'] + w['len'] + 1:
                    frac = (pos - w['pos']) / max(1, w['len'])
                    return round(w['start'] + (w['end'] - w['start']) * min(1, frac), 3)
            return words[-1]['end']

        chords = [{'pos': c['pos'], 'time': t_at(max(0, c['pos']))} for c in l.get('chords', [])]
        out_lines.append({
            'start': words[0]['start'] if words else None,
            'end': words[-1]['end'] if words else None,
            'words': words, 'chords': chords,
        })
    return {'duration': duration, 'lines': out_lines}


def main():
    audio, song_path, out_path = sys.argv[1:4]
    lang = 'cs'
    if '--lang' in sys.argv:
        lang = sys.argv[sys.argv.index('--lang') + 1]
    song = json.load(open(song_path, encoding='utf8'))
    lines = song['lines']
    work = os.path.dirname(os.path.abspath(out_path))
    vocals, inst = separate(audio, os.path.join(work, 'sep'))
    prompt = ' '.join(l['text'] for l in lines if l['text'].strip())
    theirs = transcribe(vocals, lang, prompt)
    ours = our_words(lines)
    match(ours, theirs)
    fill_times(ours, theirs)
    import torchaudio
    info = torchaudio.info(vocals)
    duration = info.num_frames / info.sample_rate
    res = build(lines, ours, duration)
    res['stats'] = {'ours': len(ours), 'transcribed': len(theirs),
                    'matched': sum(1 for o in ours if o['ok'])}
    res['transcript'] = ' '.join(t['w'] for t in theirs)
    res['vocals'], res['instrumental'] = vocals, inst
    json.dump(res, open(out_path, 'w', encoding='utf8'), ensure_ascii=False, indent=1)
    print(json.dumps(res['stats']))


if __name__ == '__main__':
    main()
