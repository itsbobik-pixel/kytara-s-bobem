"""playalong.cz – kde se text písničky rozchází s nahrávkou (po zpracování frontou).

python helper/diagnose_text.py <song_id> [<song_id> …]

Bere text písničky z DB a přepis zpěvu (WhisperX) z helper/tmp/stems/<id>/stats.json.
Vypisuje jen čísla řádků, části, procenta a počty slov – žádný text písně.
  - řádky, které v nahrávce nejsou (nebo zní jinak)
  - místa, kde nahrávka zpívá něco navíc, a jestli to vypadá jako opakování některé části (refrén…)
"""
import json, re, sys, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "worker"))
from pipeline import norm, our_words, match  # noqa: E402

SECRETS = json.loads((HERE / "secrets.json").read_text(encoding="utf-8"))
SB = re.search(r"https://[a-z0-9]+\.supabase\.co", (ROOT / "config.js").read_text(encoding="utf-8")).group(0)
LABEL = {'intro': 'Intro', 'verse': 'Sloka', 'pre': 'Předrefrén', 'chorus': 'Refrén', 'bridge': 'Bridge',
         'inter': 'Mezihra', 'solo': 'Sólo', 'outro': 'Outro'}


def get(path):
    k = SECRETS["supabase_secret"]
    req = urllib.request.Request(f"{SB}/rest/v1/{path}", headers={"apikey": k, "Authorization": "Bearer " + k})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def sections(lines):
    """[(label, first_line, last_line)] podle značek částí"""
    out, cur, start = [], None, 0
    for i, l in enumerate(lines):
        if l.get("section"):
            if cur is not None:
                out.append((cur, start, i - 1))
            cur, start = LABEL.get(l["section"], l["section"]), i
    if cur is not None:
        out.append((cur, start, len(lines) - 1))
    return out


def jacc(a, b):
    a, b = set(a), set(b)
    return len(a & b) / max(1, len(a | b))


def diagnose(sid):
    row = get(f"songs?id=eq.{sid}&select=artist,title,data")[0]
    lines = row["data"]["lines"]
    st_file = HERE / "tmp" / "stems" / sid / "stats.json"
    if not st_file.is_file():
        print(f"{sid}: chybí přepis ({st_file}) – nech písničku znovu projít frontou.")
        return
    tr = json.loads(st_file.read_text(encoding="utf-8")).get("transcript", "")
    theirs = [{"n": norm(w)} for w in re.findall(r"\S+", tr) if norm(w)]
    ours = our_words(lines)
    match(ours, theirs)
    secs = sections(lines)
    sec_of = lambda li: next((f"{lab} (ř. {a + 1}–{b + 1})" for lab, a, b in secs if a <= li <= b), "")
    print(f"\n=== {row['artist']} – {row['title']} ({sid}) ===")
    ok = sum(o["t"] is not None for o in ours)
    print(f"slova: text {len(ours)}, nahrávka {len(theirs)}, shoda {ok}/{len(ours)} ({round(100 * ok / max(1, len(ours)))} %)")

    # 1) řádky textu, které v nahrávce nejsou
    per_line = {}
    for o in ours:
        per_line.setdefault(o["line"], []).append(o["t"] is not None)
    missing = [li for li, f in sorted(per_line.items()) if len(f) >= 2 and sum(f) / len(f) < 0.5]
    if missing:
        runs, s = [], missing[0]
        for a, b in zip(missing, missing[1:] + [None]):
            if b != a + 1:
                runs.append((s, a)); s = b
        print("řádky textu, které v nahrávce nejsou / zní jinak:")
        for a, b in runs:
            print(f"   ř. {a + 1}–{b + 1}  ({sec_of(a)})" if a != b else f"   ř. {a + 1}  ({sec_of(a)})")
    else:
        print("všechny řádky textu se v nahrávce našly.")

    # 2) nahrávka zpívá něco navíc (souvislé nespárované úseky přepisu ≥ 6 slov)
    used = sorted(o["t"] for o in ours if o["t"] is not None)
    used_set = set(used)
    extra, j = [], 0
    while j < len(theirs):
        if j in used_set:
            j += 1; continue
        k = j
        while k < len(theirs) and k not in used_set:
            k += 1
        if k - j >= 6:
            extra.append((j, k))
        j = k
    if extra:
        print("nahrávka zpívá navíc (není v textu):")
        sec_words = {(lab, a, b): [o["n"] for o in ours if a <= o["line"] <= b] for lab, a, b in secs}
        for j, k in extra:
            # za kterým řádkem textu to je
            before = [o for o in ours if o["t"] is not None and o["t"] < j]
            after_line = before[-1]["line"] + 1 if before else 0
            span = [t["n"] for t in theirs[j:k]]
            best = max(sec_words.items(), key=lambda kv: jacc(span, kv[1]), default=None)
            hint = ""
            if best and jacc(span, best[1]) >= 0.35:
                lab, a, b = best[0]
                hint = f" → vypadá jako opakování: {lab} (ř. {a + 1}–{b + 1}), podobnost {round(100 * jacc(span, best[1]))} %"
            print(f"   {k - j} slov po ř. {after_line}{hint}")
    else:
        print("nahrávka nemá žádné delší úseky navíc.")


if __name__ == "__main__":
    for sid in sys.argv[1:]:
        diagnose(sid)
