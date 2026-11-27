"""playalong.cz – fronta automatických časů (běží uvnitř pomocníka, jen na adminově počítači).

Každých 20 s se podívá do tabulky `jobs` (Supabase). Když tam je úloha:
  1. stáhne zvuk z YouTube (tady doma to jde, z cloudu YouTube blokuje),
  2. nahraje ho do soukromého bucketu `jobs` a vytvoří dočasný odkaz,
  3. pošle úlohu na RunPod Serverless (worker/), počká na výsledek,
  4. uloží časy do písničky (data.sync, i s YouTube odkazem), stopy si stáhne do helper/tmp/stems/<id>/,
  5. smaže soubory z bucketu a označí úlohu jako hotovou.

Klíče jsou v helper/secrets.json (NENÍ v gitu, nikam se neposílá):
  {"supabase_secret": "sb_secret_…", "runpod_api_key": "rpa_…", "runpod_endpoint": "qv8wi96f7j66mw"}
"""
import json
import re
import shutil
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
from pathlib import Path

HELPER = Path(__file__).resolve().parent
ROOT = HELPER.parent
SECRETS = HELPER / "secrets.json"
STEMS_DIR = HELPER / "tmp" / "stems"
POLL = 20


def fill_missing_chords(lines):
    """Zpěvníky často píšou akordy jen u 1. sloky/refrénu („dál stejně“). Řádkům bez akordů v částech,
    kde akordy skoro chybí, doplní akordy podle první části stejného typu (stejné pořadí řádku, stejné pořadí slova).
    Vrací počet doplněných řádků."""
    secs, cur = [], None
    for i, l in enumerate(lines):
        if l.get("section"):
            cur = {"type": l["section"], "idx": []}
            secs.append(cur)
        if cur is not None and (l.get("text") or "").strip():
            cur["idx"].append(i)
    words = lambda t: [m.start() for m in re.finditer(r"\S+", t)]
    filled = 0
    for sec in secs:
        if not sec["idx"]:
            continue
        with_ch = sum(1 for i in sec["idx"] if lines[i]["chords"])
        if with_ch / len(sec["idx"]) >= 0.5:
            continue
        tpl = next((t for t in secs if t["type"] == sec["type"] and t is not sec and t["idx"]
                    and sum(1 for i in t["idx"] if lines[i]["chords"]) / len(t["idx"]) >= 0.8), None)
        if not tpl:
            continue
        for k, i in enumerate(sec["idx"]):
            if lines[i]["chords"]:
                continue
            src = lines[tpl["idx"][k % len(tpl["idx"])]]
            tw = words(lines[i]["text"])
            if not tw:
                continue
            ls, lt = max(1, len(src["text"])), max(1, len(lines[i]["text"]))
            new, last = [], None
            for c in src["chords"]:
                # poměrná poloha v řádku (melodie je stejná, slova jinak dlouhá); ke slovu, když je blízko
                pos = c["pos"] if c["pos"] < 0 else round(c["pos"] / ls * lt)
                if pos >= 0:
                    near = min(tw, key=lambda w: abs(w - pos))
                    if abs(near - pos) <= 2:
                        pos = near
                if last is not None and pos <= last:
                    pos = last + 1
                new.append({**c, "pos": pos})
                last = pos
            lines[i]["chords"] = new
            filled += 1
    return filled


def transpose_song(data, shift):
    """celou písničku (akordy, tóninu) posune o shift půltónů; původní tóninu si pamatuje v baseKey"""
    t = lambda r: (r + shift) % 12
    for l in data.get("lines") or []:
        for c in l.get("chords") or []:
            c["root"] = t(c["root"])
            if c.get("bass") is not None:
                c["bass"] = t(c["bass"])
    for c in data.get("custom") or []:
        c["root"] = t(c["root"])
        if c.get("bass") is not None:
            c["bass"] = t(c["bass"])
    if data.get("key"):
        if not data.get("baseKey"):
            data["baseKey"] = dict(data["key"])
        data["key"]["root"] = t(data["key"]["root"])


def _supabase_url():
    m = re.search(r"https://[a-z0-9]+\.supabase\.co", (ROOT / "config.js").read_text(encoding="utf-8"))
    return m.group(0)


class Queue:
    def __init__(self, download_audio):
        cfg = json.loads(SECRETS.read_text(encoding="utf-8"))
        self.sb = _supabase_url()
        self.key = cfg["supabase_secret"]
        self.rp_key = cfg["runpod_api_key"]
        self.endpoint = cfg.get("runpod_endpoint", "qv8wi96f7j66mw")
        self.download_audio = download_audio

    # ---------- HTTP ----------
    def _req(self, method, url, body=None, headers=None, raw=False, timeout=60):
        h = dict(headers or {})
        data = None
        if body is not None:
            if isinstance(body, (bytes, bytearray)):
                data = bytes(body)
            else:
                data = json.dumps(body).encode("utf-8")
                h.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            out = r.read()
        if raw:
            return out
        return json.loads(out) if out else None

    def _sbh(self, extra=None):
        h = {"apikey": self.key, "Authorization": "Bearer " + self.key}
        h.update(extra or {})
        return h

    def rest(self, method, path, body=None, prefer=None):
        h = self._sbh({"Prefer": prefer} if prefer else None)
        return self._req(method, f"{self.sb}/rest/v1/{path}", body, h)

    def storage(self, method, path, body=None, headers=None, raw=False):
        return self._req(method, f"{self.sb}/storage/v1/{path}", body, self._sbh(headers), raw=raw, timeout=300)

    def runpod(self, method, path, body=None):
        h = {"Authorization": "Bearer " + self.rp_key}
        return self._req(method, f"https://api.runpod.ai/v2/{self.endpoint}/{path}", body, h)

    # ---------- práce ----------
    def set_job(self, jid, **fields):
        fields["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.rest("PATCH", f"jobs?id=eq.{jid}", fields)

    def claim(self):
        rows = self.rest("GET", "jobs?status=eq.queued&order=created_at.asc&limit=1&select=id,song_id,yt")
        if not rows:
            return None
        job = rows[0]
        # zaber jen pokud je pořád ve frontě (kdyby běžely dva pomocníky)
        got = self.rest("PATCH", f"jobs?id=eq.{job['id']}&status=eq.queued",
                        {"status": "working"}, prefer="return=representation")
        return job if got else None

    def process(self, job):
        jid, sid, yt = job["id"], job["song_id"], job["yt"]
        print(f"⏱  úloha {jid[:8]}: song {sid}, YouTube {yt}")
        rows = self.rest("GET", f"songs?id=eq.{sid}&select=data")
        if not rows:
            raise RuntimeError("Písnička už neexistuje.")
        lines = rows[0]["data"].get("lines") or []
        if not any((l.get("text") or "").strip() for l in lines):
            raise RuntimeError("Písnička nemá text.")
        n = fill_missing_chords(lines)
        if n:
            data = rows[0]["data"]
            data["lines"] = lines
            self.rest("PATCH", f"songs?id=eq.{sid}", {"data": data})
            print(f"   ♪ doplněny akordy u {n} řádků (podle 1. sloky/refrénu)")
        work = Path(tempfile.mkdtemp(prefix="playalong-job-"))
        prefix = f"{jid}"
        try:
            audio, title, _ = self.download_audio(f"https://www.youtube.com/watch?v={yt}", work)
            print(f"   ⬇ {title} ({audio.stat().st_size // 1024} kB)")
            ext = audio.suffix.lstrip(".") or "m4a"
            obj = f"{prefix}/audio.{ext}"
            self.storage("POST", f"object/jobs/{obj}", audio.read_bytes(),
                         {"Content-Type": "audio/mp4" if ext == "m4a" else "audio/" + ext, "x-upsert": "true"})
            signed = self.storage("POST", f"object/sign/jobs/{obj}", {"expiresIn": 3600})
            audio_url = self.sb + "/storage/v1" + signed["signedURL"]
            up = {}
            for stem in ("vocals", "no_vocals"):
                u = self.storage("POST", f"object/upload/sign/jobs/{prefix}/{stem}.mp3", {})
                up[stem] = self.sb + "/storage/v1" + u["url"]
            payload = {"input": {"audio_url": audio_url, "song": {"lines": lines}, "lang": "cs", "stems_upload": up},
                       "policy": {"executionTimeout": 900000}}
            run = self.runpod("POST", "run", payload)
            rid = run["id"]
            print(f"   ☁ RunPod úloha {rid}")
            t0 = time.time()
            while True:
                time.sleep(5)
                st = self.runpod("GET", f"status/{rid}")
                if st["status"] == "COMPLETED":
                    out = st["output"]
                    break
                if st["status"] in ("FAILED", "CANCELLED", "TIMED_OUT"):
                    raise RuntimeError(f"RunPod: {st['status']} {str(st.get('error') or '')[:300]}")
                if time.time() - t0 > 25 * 60:
                    self.runpod("POST", f"cancel/{rid}")
                    raise RuntimeError("RunPod nestihl do 25 minut.")
            sync = out["sync"]
            sync["yt"] = yt
            # uložit do písničky (čerstvá data – mezitím se mohla změnit)
            cur = self.rest("GET", f"songs?id=eq.{sid}&select=data")[0]["data"]
            if len(cur.get("lines") or []) != len(lines):
                raise RuntimeError("Text písničky se mezitím změnil – spusť to znovu.")
            cur["sync"] = sync
            shift = int((out.get("stats") or {}).get("shift") or 0)
            if shift and (out["stats"].get("chordFit") or 0) >= 60:
                # nahrávka je v jiné tónině než zápis → písnička do tóniny nahrávky (play-along hraje vždy v ní)
                transpose_song(cur, shift)
                print(f"   ♪ převedeno do tóniny nahrávky ({shift:+d} půltónů)")
            self.rest("PATCH", f"songs?id=eq.{sid}", {"data": cur})
            # stopy k sobě (karaoke posuvník pro admina)
            dest = STEMS_DIR / sid
            dest.mkdir(parents=True, exist_ok=True)
            for stem in ("vocals", "no_vocals"):
                try:
                    data = self.storage("GET", f"object/jobs/{prefix}/{stem}.mp3", raw=True)
                    (dest / f"{stem}.mp3").write_bytes(data)
                except urllib.error.HTTPError:
                    pass
            (dest / "sync.json").write_text(json.dumps(sync, ensure_ascii=False), encoding="utf-8")
            # přepis zpěvu (WhisperX) + statistiky – jen lokálně, pro diagnostiku nesedícího textu
            (dest / "stats.json").write_text(json.dumps(out.get("stats") or {}, ensure_ascii=False), encoding="utf-8")
            stats = {k: v for k, v in (out.get("stats") or {}).items() if k != "transcript"}
            self.set_job(jid, status="done", stats=stats)
            print(f"   ✓ hotovo: slova {stats.get('matched')}/{stats.get('ours')}, {stats.get('bpm')} BPM, {stats.get('seconds')} s")
        finally:
            shutil.rmtree(work, ignore_errors=True)
            try:
                self.storage("DELETE", "object/jobs", {"prefixes": [f"{prefix}/audio.m4a", f"{prefix}/audio.webm",
                                                                      f"{prefix}/audio.mp3", f"{prefix}/audio.opus",
                                                                      f"{prefix}/vocals.mp3", f"{prefix}/no_vocals.mp3"]})
            except Exception:  # noqa: BLE001
                pass

    def loop(self):
        print("⏱  fronta automatických časů: hlídám")
        # úlohy, které zůstaly 'working' po pádu pomocníka, vrať do fronty
        try:
            self.rest("PATCH", "jobs?status=eq.working", {"status": "queued"})
        except Exception:  # noqa: BLE001
            pass
        while True:
            job = None
            try:
                job = self.claim()
                if job:
                    self.process(job)
                    continue
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                if isinstance(e, urllib.error.HTTPError):
                    try:
                        msg = f"{e.code} {e.read().decode('utf-8', 'replace')[:300]}"
                    except Exception:  # noqa: BLE001
                        pass
                print(f"   ✗ {msg}")
                if job:
                    traceback.print_exc()
                    try:
                        self.set_job(job["id"], status="error", error=msg[:500])
                    except Exception:  # noqa: BLE001
                        pass
            time.sleep(POLL)


def start(download_audio):
    if not SECRETS.is_file():
        print("   (Fronta automatických časů je vypnutá – chybí helper/secrets.json.)")
        return None
    try:
        q = Queue(download_audio)
    except Exception as e:  # noqa: BLE001
        print(f"   ✗ Fronta: špatný helper/secrets.json ({e})")
        return None
    threading.Thread(target=q.loop, daemon=True).start()
    return q
