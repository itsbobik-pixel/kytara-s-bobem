"""RunPod Serverless handler – playalong.cz.

input = {
  "audio_url": "https://…mp3",            # odkud stáhnout nahrávku (např. podepsaná URL ze Supabase Storage)
  "song": {"lines": [...]},               # jako song.lines v appce
  "lang": "cs",                           # volitelně
  "stems_upload": {"vocals": "PUT url", "no_vocals": "PUT url"}   # volitelně: kam nahrát stopy (mp3)
}
output = {"sync": {...}, "stats": {...}}
"""
import glob, os, shutil, tempfile, time, urllib.request
import runpod
from pipeline import separate, compute_sync


def _fix_cuda_libs():
    # ctranslate2 (faster-whisper) hledá cuDNN/cuBLAS z pip balíčků nvidia-*
    import site
    paths = []
    for sp in site.getsitepackages():
        paths += glob.glob(os.path.join(sp, 'nvidia', '*', 'lib'))
    if paths:
        os.environ['LD_LIBRARY_PATH'] = ':'.join(paths + [os.environ.get('LD_LIBRARY_PATH', '')])


def _put(url, path):
    data = open(path, 'rb').read()
    req = urllib.request.Request(url, data=data, method='PUT', headers={'Content-Type': 'audio/mpeg', 'x-upsert': 'true'})
    urllib.request.urlopen(req, timeout=120).read()


def handler(job):
    inp = job['input']
    t0 = time.time()
    log = []
    say = lambda m: (log.append('%.1fs %s' % (time.time() - t0, m)), print(m, flush=True))
    work = tempfile.mkdtemp()
    try:
        audio = os.path.join(work, 'song.mp3')
        req = urllib.request.Request(inp['audio_url'], headers={'User-Agent': 'playalong-worker'})
        with urllib.request.urlopen(req, timeout=120) as r, open(audio, 'wb') as f:
            shutil.copyfileobj(r, f)
        say('audio %.1f MB' % (os.path.getsize(audio) / 1e6))
        vocals, inst = separate(audio, os.path.join(work, 'sep'))
        say('demucs hotovo')
        lines = inp['song']['lines']
        sync, stats, _ = compute_sync(lines, vocals, inst, lang=inp.get('lang', 'cs'), log=say)
        up = inp.get('stems_upload') or {}
        if up.get('vocals'):
            _put(up['vocals'], vocals)
        if up.get('no_vocals'):
            _put(up['no_vocals'], inst)
        if up:
            say('stopy nahrány')
        stats['seconds'] = round(time.time() - t0, 1)
        stats['log'] = log
        return {'sync': sync, 'stats': stats}
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == '__main__':
    _fix_cuda_libs()
    runpod.serverless.start({'handler': handler})
