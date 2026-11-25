#!/usr/bin/env python3
"""
playalong.cz – lokální pomocník.

Běží jen na tvém počítači (127.0.0.1) a dělá dvě věci:
  1. /audio?url=<YouTube odkaz>  stáhne zvukovou stopu (yt-dlp) a pošle ji appce,
     která v prohlížeči pozná tóninu. Nic se neukládá, dočasný soubor se hned maže.
  2. servíruje samotnou appku na http://127.0.0.1:5174/

Spuštění:  python helper/kytara_helper.py   (nebo dvojklik na spustit-pomocnika.bat)
"""
import http.server
import json
import mimetypes
import re
import shutil
import sys
import tempfile
import urllib.parse
from pathlib import Path

try:
    import yt_dlp
except ImportError:
    print('Chybí yt-dlp. Nainstaluj ho:  python -m pip install -U "yt-dlp[default]"')
    sys.exit(1)

HOST, PORT = "127.0.0.1", 5174
ROOT = Path(__file__).resolve().parent.parent          # složka s appkou
MAX_SECONDS = 15 * 60                                  # delší videa nestahujeme

# Stránky, které se smí pomocníka ptát. Doplň sem svou GitHub Pages adresu, pokud ji změníš.
ALLOWED_ORIGINS = re.compile(
    r"^(null|https?://(localhost|127\.0\.0\.1)(:\d+)?|https://itsbobik-pixel\.github\.io)$"
)
# oddělené stopy a časy pro play-along: helper/tmp/stems/<id songu>/
STEMS_DIR = ROOT / "helper" / "tmp" / "stems"
STEM_FILES = ("vocals.mp3", "no_vocals.mp3", "sync.json")
STEM_PATH = re.compile(r"^/stems/([A-Za-z0-9]{4,40})/(|vocals\.mp3|no_vocals\.mp3|sync\.json)$")
YT_URL = re.compile(r"^https://(www\.|m\.|music\.)?(youtube\.com/(watch\?|shorts/|live/)|youtu\.be/)[\w\-?=&%./]+$", re.I)


def download_audio(url: str, workdir: Path):
    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
        "outtmpl": str(workdir / "audio.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "match_filter": yt_dlp.utils.match_filter_func(f"duration < {MAX_SECONDS}"),
        # YouTube dnes vyžaduje JavaScript runtime – použijeme Node (nebo Deno, je-li nainstalované)
        "js_runtimes": {"node": {}, "deno": {}},
        "remote_components": ["ejs:github"],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    if not info:
        raise RuntimeError("Video je delší než 15 minut, nebo se nedá stáhnout.")
    files = [p for p in workdir.iterdir() if p.is_file() and not p.name.endswith(".part")]
    if not files:
        raise RuntimeError("Video je delší než 15 minut, nebo se nedá stáhnout.")
    return files[0], info.get("title") or "", info.get("duration") or 0


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    # --- CORS (jen pro povolené stránky) ---
    def _origin_ok(self):
        origin = self.headers.get("Origin")
        return origin is None or bool(ALLOWED_ORIGINS.match(origin))

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and ALLOWED_ORIGINS.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Expose-Headers", "X-Title, X-Duration")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        if not self._origin_ok():
            self.send_response(403); self.end_headers(); return
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _stems(self, path):
        """/stems/<id>/ → co je k dispozici; /stems/<id>/<soubor> → soubor (vokál, doprovod, časy)"""
        m = STEM_PATH.match(path)
        if not m:
            self._json(404, {"error": "Neznámý soubor."}); return
        folder = STEMS_DIR / m.group(1)
        name = m.group(2)
        if not name:
            self._json(200, {f: (folder / f).is_file() for f in STEM_FILES})
            return
        f = folder / name
        if not f.is_file():
            self._json(404, {"error": "Soubor tu není."}); return
        data = f.read_bytes()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json" if name.endswith(".json") else "audio/mpeg")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith(("/health", "/audio", "/stems")) and not self._origin_ok():
            self._json(403, {"error": "Tahle stránka nemá k pomocníkovi přístup."})
            return
        if parsed.path.startswith("/stems/"):
            self._stems(parsed.path)
            return
        if parsed.path == "/health":
            self._json(200, {"ok": True, "app": "kytara-s-bobem", "yt_dlp": yt_dlp.version.__version__})
            return
        if parsed.path == "/audio":
            self._audio(urllib.parse.parse_qs(parsed.query).get("url", [""])[0])
            return
        if parsed.path.startswith(("/helper", "/.git", "/.claude")):
            self.send_error(404); return
        super().do_GET()

    def _audio(self, url):
        url = url.strip()
        if not YT_URL.match(url):
            self._json(400, {"error": "Tohle nevypadá jako odkaz na YouTube video."})
            return
        workdir = Path(tempfile.mkdtemp(prefix="kytara-"))
        try:
            print(f"⬇  {url}")
            path, title, duration = download_audio(url, workdir)
            data = path.read_bytes()
            ctype = mimetypes.guess_type(path.name)[0] or ("audio/mp4" if path.suffix == ".m4a" else "audio/webm")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("X-Title", urllib.parse.quote(title))
            self.send_header("X-Duration", str(duration))
            self.end_headers()
            self.wfile.write(data)
            print(f"✓  {title} ({len(data) // 1024} kB)")
        except Exception as e:  # noqa: BLE001 – chybu chceme ukázat v appce
            msg = str(e)
            if "Sign in to confirm" in msg:
                msg = "YouTube chce ověření, že nejsi robot. Zkus to za chvíli znovu, nebo nahraj MP3."
            elif "Private video" in msg or "unavailable" in msg.lower():
                msg = "Video je soukromé nebo nedostupné."
            elif "duration" in msg or "15 minut" in msg:
                msg = "Video je delší než 15 minut."
            else:
                msg = "Stažení z YouTube se nepovedlo. Zkus aktualizovat yt-dlp (spustit-pomocnika.bat to udělá)."
            print(f"✗  {e}")
            self._json(502, {"error": msg})
        finally:
            shutil.rmtree(workdir, ignore_errors=True)

    def log_message(self, fmt, *args):  # tišší výpis
        if "/health" not in str(args[0] if args else ""):
            sys.stderr.write("   " + fmt % args + "\n")


def main():
    server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
    print("🎸 playalong.cz – pomocník běží")
    print(f"   Appka:   http://{HOST}:{PORT}/")
    print("   Ukončení: Ctrl+C nebo zavři tohle okno\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
