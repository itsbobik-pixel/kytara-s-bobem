# 🎸 Kytara s Bobem

Barevný zpěvník: vlož text písničky, vyber tóninu a **přetáhni akordy** přímo nad slova. Stejně tak přetáhneš i části písně (intro, sloka, refrén…).

**Web:** https://itsbobik-pixel.github.io/kytara-s-bobem/

## Co umí

- Přidání songu z textu. Když text obsahuje akordy (nad řádky nebo jako `[Am]`), pozná je a odhadne tóninu.
- Paleta akordů podle tóniny, každý stupeň má svoji barvu.
- Drag & drop akordů a částí písně, myší i prstem.
- Transpozice, kapodastr, režim **Hrát** s automatickým posouváním.
- **Tónina z nahrávky:** nahraj MP3 (nebo m4a, wav…) a appka v prohlížeči pozná tóninu, nabídne 3 nejpravděpodobnější a tip na kapodastr. Soubor se nikam neposílá.
- **Tónina z YouTube:** funguje, když na počítači běží lokální pomocník (viz níže).

## Společný zpěvník (Supabase)

Songy jsou v databázi [Supabase](https://supabase.com) a **vidí je všichni**. Přidávat může jen přihlášený (odkazem z e-mailu, bez hesla). Upravit a smazat song smí jen ten, kdo ho přidal, nebo admin. Song jde přepnout na **🔒 Jen pro mě**.

Nastavení (jednou):

1. V Supabase otevři **SQL Editor → New query**, vlož celý [supabase/schema.sql](supabase/schema.sql) a dej **Run**.
2. **Authentication → URL Configuration**:
   - *Site URL*: `https://itsbobik-pixel.github.io/kytara-s-bobem/`
   - *Redirect URLs*: přidej `https://itsbobik-pixel.github.io/kytara-s-bobem/`, `http://127.0.0.1:5174/` a `http://localhost:5173/`
3. Přihlas se na webu. Pak se udělej adminem v SQL Editoru (dosaď svůj e-mail):
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'TVUJ@EMAIL.CZ';
   ```

Adresa projektu a veřejný (publishable) klíč jsou v [config.js](config.js). Klíč `sb_secret_…` do webu nikdy nepatří.

Bez `config.js` (nebo ve verzi na claude.ai) se songy ukládají jen v prohlížeči, popř. do cloudu claude.ai.

## Lokální pomocník pro YouTube

Prohlížeč sám zvuk z YouTube stáhnout nemůže, proto je tu malý pomocník v Pythonu ([helper/kytara_helper.py](helper/kytara_helper.py)), který používá [yt-dlp](https://github.com/yt-dlp/yt-dlp).

1. Potřebuješ Python 3 a Node.js (yt-dlp ho používá pro YouTube).
2. Dvojklik na **`spustit-pomocnika.bat`**. Aktualizuje yt-dlp, spustí pomocníka a otevře appku na http://127.0.0.1:5174/.
3. Pak funguje YouTube odkaz i z webové verze na GitHub Pages, dokud okno pomocníka necháš otevřené.

Pomocník poslouchá jen na tvém počítači (127.0.0.1) a odpovídá jen appce. Stažený zvuk hned maže.

> Stahování zvuku z YouTube je v rozporu s jejich podmínkami užití. Používej to jen pro vlastní potřebu.

## Play-along (zkušební)

V režimu hraní je tlačítko **🎵 Play-along**: hraje hudba, text se přebarvuje podle zpěvu a akordy svítí ve chvíli, kdy hrají. Posuvník 🎤 ztlumí zpěv (karaoke). Tlačítkem **✎ Doladit** se otevře časová osa, kde jde tažením posunout slovo, akord nebo celý řádek.

Časy vznikají skriptem [helper/align.py](helper/align.py) na grafické kartě (zkoušeno na RunPodu): Demucs oddělí vokál, WhisperX najde čas každého slova a skript ho přiřadí k textu písničky. Výsledek (`vocals.mp3`, `no_vocals.mp3`, `sync.json`) patří do `helper/tmp/stems/<id songu>/`, odkud ho appce posílá pomocník. Časy se pak uloží k songu, zvuk zůstává jen u tebe.

## Vývoj

Čisté HTML, CSS a JavaScript bez buildu: `index.html`, `styles.css`, `app.js`, `keydetect.js`. Soubor `artifact.html` je verze pro claude.ai.
