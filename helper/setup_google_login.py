"""Zapne v Supabase přihlášení přes Google podle helper/google-login.txt (Management API).
Kódy nevypisuje; po úspěchu je ze souboru smaže."""
import json, re, sys, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
TXT = HERE / "google-login.txt"
REF = re.search(r"https://([a-z0-9]+)\.supabase\.co", (HERE.parent / "config.js").read_text(encoding="utf-8")).group(1)

vals = {}
for line in TXT.read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\s*([A-Z_]+)\s*=\s*(.*?)\s*$", line)
    if m:
        vals[m.group(1)] = m.group(2).strip().strip('"').strip("'")
need = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "SUPABASE_ACCESS_TOKEN"]
missing = [k for k in need if not vals.get(k)]
if missing:
    print("Chybí v souboru:", ", ".join(missing)); sys.exit(1)
if not vals["GOOGLE_CLIENT_ID"].endswith(".apps.googleusercontent.com"):
    print("GOOGLE_CLIENT_ID nevypadá správně (má končit .apps.googleusercontent.com)."); sys.exit(1)

body = {"external_google_enabled": True,
        "external_google_client_id": vals["GOOGLE_CLIENT_ID"],
        "external_google_secret": vals["GOOGLE_CLIENT_SECRET"]}
req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/config/auth", data=json.dumps(body).encode(),
                             method="PATCH", headers={"Authorization": "Bearer " + vals["SUPABASE_ACCESS_TOKEN"],
                                                      "Content-Type": "application/json"})
try:
    res = json.loads(urllib.request.urlopen(req, timeout=30).read() or b"{}")
except urllib.error.HTTPError as e:
    print("Supabase odmítl:", e.code, e.read().decode("utf-8", "replace")[:200]); sys.exit(1)
print("Google přihlášení zapnuto:", res.get("external_google_enabled"))

# kódy ze souboru smazat (šablona zůstane)
out = []
for line in TXT.read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\s*([A-Z_]+)\s*=", line)
    out.append(f"{m.group(1)}=" if m and m.group(1) in need else line)
TXT.write_text("\n".join(out) + "\n", encoding="utf-8")
print("Kódy ze souboru google-login.txt smazány.")
