"""Uloží API klíč Resendu z helper/resend-key.txt do Supabase Vaultu (RPC set_resend_key, jen service role).
Klíč nevypisuje; po úspěchu ho ze souboru smaže."""
import json, re, sys, urllib.error, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
TXT = HERE / "resend-key.txt"
URL = re.search(r"https://[a-z0-9]+\.supabase\.co", (HERE.parent / "config.js").read_text(encoding="utf-8")).group(0)
SECRET = json.loads((HERE / "secrets.json").read_text(encoding="utf-8"))["supabase_secret"]

key = ""
for line in TXT.read_text(encoding="utf-8").splitlines():
    m = re.match(r"^\s*RESEND_API_KEY\s*=\s*(.*?)\s*$", line)
    if m:
        key = m.group(1).strip().strip('"').strip("'")
if not key:
    print("V souboru resend-key.txt chybí klíč."); sys.exit(1)
if not re.match(r"^re_[A-Za-z0-9_]{10,}$", key):
    print("Klíč nevypadá správně (má začínat re_)."); sys.exit(1)

req = urllib.request.Request(URL + "/rest/v1/rpc/set_resend_key", data=json.dumps({"k": key}).encode(), method="POST",
                             headers={"apikey": SECRET, "Authorization": "Bearer " + SECRET, "Content-Type": "application/json"})
try:
    res = json.loads(urllib.request.urlopen(req, timeout=30).read() or b"null")
except urllib.error.HTTPError as e:
    print("Supabase odmítl:", e.code, e.read().decode("utf-8", "replace")[:200]); sys.exit(1)
print("Klíč uložen do Vaultu:", res)

out = [("RESEND_API_KEY=" if re.match(r"^\s*RESEND_API_KEY\s*=", l) else l) for l in TXT.read_text(encoding="utf-8").splitlines()]
TXT.write_text("\n".join(out) + "\n", encoding="utf-8")
print("Klíč ze souboru resend-key.txt smazán.")
