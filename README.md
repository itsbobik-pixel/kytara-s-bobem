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

Songy se zatím ukládají v prohlížeči (localStorage). Zálohu stáhneš tlačítkem **⬇ Záloha**.

## Lokální pomocník pro YouTube

Prohlížeč sám zvuk z YouTube stáhnout nemůže, proto je tu malý pomocník v Pythonu ([helper/kytara_helper.py](helper/kytara_helper.py)), který používá [yt-dlp](https://github.com/yt-dlp/yt-dlp).

1. Potřebuješ Python 3 a Node.js (yt-dlp ho používá pro YouTube).
2. Dvojklik na **`spustit-pomocnika.bat`**. Aktualizuje yt-dlp, spustí pomocníka a otevře appku na http://127.0.0.1:5174/.
3. Pak funguje YouTube odkaz i z webové verze na GitHub Pages, dokud okno pomocníka necháš otevřené.

Pomocník poslouchá jen na tvém počítači (127.0.0.1) a odpovídá jen appce. Stažený zvuk hned maže.

> Stahování zvuku z YouTube je v rozporu s jejich podmínkami užití. Používej to jen pro vlastní potřebu.

## Vývoj

Čisté HTML, CSS a JavaScript bez buildu: `index.html`, `styles.css`, `app.js`, `keydetect.js`. Soubor `artifact.html` je verze pro claude.ai.
