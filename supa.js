'use strict';
/* =========================================================
   playalong.cz – společný zpěvník přes Supabase
   Aktivuje se jen když config.js obsahuje URL + publishable key.
   Používá globální proměnné z app.js (songs, render, toast, h…).
   ========================================================= */
window.KSB_SUPA = (() => {
  const cfg = window.KSB_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseKey || !window.supabase?.createClient) return null;

  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true },
  });

  const synced = new Map();   // id → JSON uloženého stavu (jen NAČTENÉ songy, které smím upravit)
  const inDb = new Set();     // id songů, které už v databázi existují
  const editable = new Set(); // id songů v databázi, které smím upravit/smazat (i nenačtené)
  const loading = new Map();  // id → probíhající načítání celé písničky
  let timer = 0, flushing = false, again = false;
  const jobs = new Map();     // song id → stav úlohy na automatické časy ('queued' | 'working')

  const payload = s => ({
    title: (s.title || '').slice(0, 200),
    artist: (s.artist || '').slice(0, 200),
    is_public: s.isPublic !== false,
    data: { key: s.key, baseKey: s.baseKey || null, capo: s.capo || 0, lines: s.lines, custom: s.custom || [], sync: s.sync || null },
  });
  // Seznam stahuje jen názvy (šetří přenos dat); celá písnička se načte až při otevření.
  // Nenačtená písnička má partial: true a NIKDY se neukládá (jinak by se v databázi přepsala prázdnou).
  const META = 'id, owner, author_name, title, artist, is_public, approved, updated_at, sync_dur:data->sync->>dur';
  const FULL = 'id, owner, author_name, title, artist, is_public, approved, updated_at, data';
  const fromMeta = r => ({
    id: r.id, title: r.title, artist: r.artist,
    key: { root: 7, minor: false }, capo: 0, baseKey: null, lines: [], custom: [], sync: null,
    updated: Date.parse(r.updated_at) || 0, serverUpdated: r.updated_at,
    owner: r.owner, author: r.author_name || '', isPublic: r.is_public,
    approved: r.approved !== false, hasSync: r.sync_dur != null,
    partial: true,
  });
  const fromRow = r => ({
    serverUpdated: r.updated_at,
    id: r.id,
    title: r.title,
    artist: r.artist,
    key: r.data?.key || { root: 7, minor: false },
    capo: r.data?.capo || 0,
    baseKey: r.data?.baseKey || null,
    lines: Array.isArray(r.data?.lines) ? r.data.lines : [],
    custom: r.data?.custom || [],
    sync: r.data?.sync || null,
    updated: Date.parse(r.updated_at) || 0,
    owner: r.owner,
    author: r.author_name || '',
    isPublic: r.is_public,
    approved: r.approved !== false,
    hasSync: !!r.data?.sync,
  });

  async function fetchSongs() {
    const { data, error } = await sb.from('songs')
      .select(META)
      .order('updated_at', { ascending: false })
      .limit(5000);
    if (error) throw error;
    // co už mám celé načtené a v databázi se od té doby nezměnilo, si nechám
    const prev = new Map(songs.map(s => [s.id, s]));
    return data.map(r => {
      const p = prev.get(r.id);
      if (p && !p.partial && p.serverUpdated === r.updated_at) {
        p.title = r.title; p.artist = r.artist; p.owner = r.owner; p.author = r.author_name || ''; p.isPublic = r.is_public; p.approved = r.approved !== false;
        return p;
      }
      return fromMeta(r);
    });
  }

  function rememberSynced(list) {
    synced.clear(); inDb.clear(); editable.clear();
    for (const s of list) {
      inDb.add(s.id);
      if (canEdit(s)) {
        editable.add(s.id);
        if (!s.partial) synced.set(s.id, JSON.stringify(payload(s)));
      }
    }
  }

  /** načte celou písničku (text, akordy, časy), pokud ještě není */
  function ensureLoaded(id) {
    const s = songs.find(x => x.id === id);
    if (!s || !s.partial) return Promise.resolve(s);
    if (loading.has(id)) return loading.get(id);
    const pr = (async () => {
      const { data, error } = await sb.from('songs').select(FULL).eq('id', id).maybeSingle();
      if (error) throw error;
      const i = songs.findIndex(x => x.id === id);
      if (!data) { if (i >= 0) songs.splice(i, 1); return null; }
      const full = fromRow(data);
      if (i >= 0) songs[i] = full; else songs.push(full);
      if (canEdit(full)) { editable.add(id); synced.set(id, JSON.stringify(payload(full))); }
      return full;
    })().finally(() => loading.delete(id));
    loading.set(id, pr);
    return pr;
  }

  /** admin: schválit song (pak ho vidí všichni) */
  async function approve(id) {
    const { data, error } = await sb.from('songs').update({ approved: true }).eq('id', id).select('updated_at').maybeSingle();
    if (error || !data) throw error || new Error('nic');
    const s = songs.find(x => x.id === id);
    if (s) { s.approved = true; s.serverUpdated = data.updated_at; }
  }

  /** načte všechny nenačtené písničky (pro zálohu) */
  async function loadAll() {
    const ids = songs.filter(s => s.partial).map(s => s.id);
    for (let i = 0; i < ids.length; i += 50) {
      const { data, error } = await sb.from('songs').select(FULL).in('id', ids.slice(i, i + 50));
      if (error) throw error;
      for (const r of data) {
        const j = songs.findIndex(x => x.id === r.id);
        if (j >= 0 && songs[j].partial) {
          songs[j] = fromRow(r);
          if (canEdit(songs[j])) synced.set(r.id, JSON.stringify(payload(songs[j])));
        }
      }
    }
  }

  async function loadUser(session) {
    const user = session?.user || null;
    auth.user = user;
    auth.admin = false;
    auth.anon = !!user?.is_anonymous;
    auth.name = user?.user_metadata?.name || (auth.anon ? 'Host' : '');
    // značení akordů: nastavení účtu; bez účtu vždy mezinárodní (B)
    settings.notation = (user && !auth.anon && user.user_metadata?.notation) || (user && !auth.anon ? settings.notation : 'intl');
    if (user) {
      const { data } = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
      auth.admin = !!data;
    }
  }

  const fits = new Map();      // song id → % slov textu nalezených v nahrávce (poslední hotová úloha)
  async function fetchJobs() {
    const { data, error } = await sb.from('jobs').select('song_id, status, stats, created_at')
      .in('status', ['queued', 'working', 'done']).order('created_at', { ascending: true });
    if (error) return;
    jobs.clear(); fits.clear();
    for (const j of data) {
      if (j.status === 'done') {
        const st = j.stats || {};
        if (st.ours) fits.set(j.song_id, { text: Math.round(100 * st.matched / st.ours), chords: st.chordFit ?? null, shift: st.shift || 0 });
      } else jobs.set(j.song_id, j.status);
    }
  }

  async function reload({ quiet = false } = {}) {
    try {
      const [list] = await Promise.all([fetchSongs(), fetchJobs()]);
      songs = list;
      rememberSynced(list);
      auth.loading = false;
      setStatus('');
      if (!quiet || !document.activeElement?.matches?.('input, textarea')) render();
    } catch (e) {
      auth.loading = false;
      setStatus('⚠ Zpěvník se nepodařilo načíst');
      if (!quiet) { render(); toast('Zpěvník se nepodařilo načíst. Zkontroluj připojení.'); }
    }
  }

  async function init() {
    auth.mode = 'supabase';
    auth.loading = true;
    auth.localOnly = songs.slice();         // co bylo dřív jen v prohlížeči
    songs = [];
    render();

    const { data: { session } } = await sb.auth.getSession();
    // po přihlášení odkazem z e-mailu ukliď ?code= z adresy
    if (location.search.includes('code=')) history.replaceState(null, '', location.pathname + location.hash);
    await loadUser(session);
    await reload();
    if (auth.user && !auth.anon && !auth.name) openNameModal();

    // Pozor: uvnitř onAuthStateChange se nesmí čekat na další volání Supabase (zasekne se zámek
    // přihlášení a např. updateUser nikdy nedoběhne) → práci odložíme mimo callback.
    sb.auth.onAuthStateChange((event, sess) => {
      if (event === 'PASSWORD_RECOVERY') { setTimeout(openNewPassword, 0); return; }
      if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT' && event !== 'USER_UPDATED') return;
      setTimeout(async () => {
        const before = auth.user?.id;
        await loadUser(sess);
        if (before !== auth.user?.id) await reload();
        else render();
      }, 0);
    });

    // po návratu do okna načti novinky od ostatních (když nic neukládám)
    window.addEventListener('focus', () => {
      if (!flushing && !timer && !drag && $('#modalRoot').children.length === 0) reload({ quiet: true });
    });
  }

  function schedule(delay = 800) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; flush(); }, delay);
  }

  async function flush() {
    if (!auth.user) return;
    if (flushing) { again = true; return; }
    flushing = true;
    setStatus('Ukládám…');
    let failed = false;
    try {
      const ids = new Set();
      for (const s of songs) {
        ids.add(s.id);
        if (!canEdit(s) || s.partial) continue;   // nenačtenou písničku nikdy neukládat
        const p = payload(s);
        const json = JSON.stringify(p);
        if (synced.get(s.id) === json) continue;
        let res;
        if (inDb.has(s.id)) {
          res = await sb.from('songs').update(p).eq('id', s.id).select('updated_at').maybeSingle();
          if (!res.error && res.data) s.serverUpdated = res.data.updated_at;
        } else {
          res = await sb.from('songs').insert({ id: s.id, author_name: auth.name || 'Kytarista', ...p })
            .select('owner, author_name, updated_at, approved').single();
          if (!res.error) {
            inDb.add(s.id); editable.add(s.id); s.owner = res.data.owner; s.author = res.data.author_name; s.serverUpdated = res.data.updated_at;
            s.approved = res.data.approved;
            if (!s.approved) toast('Song je uložený. Ostatní ho uvidí, až ho admin schválí.');
          }
        }
        if (res.error) { failed = true; console.warn('Uložení selhalo', s.id, res.error.message); continue; }
        synced.set(s.id, json);
      }
      // smazané: písničky v databázi, které smím upravit, ale v seznamu už nejsou (i nenačtené)
      for (const id of [...editable]) {
        if (ids.has(id)) continue;
        const { error } = await sb.from('songs').delete().eq('id', id);
        if (error) { failed = true; continue; }
        synced.delete(id); inDb.delete(id); editable.delete(id);
      }
    } finally {
      flushing = false;
      setStatus(failed ? '⚠ Něco se neuložilo, zkouším znovu' : '✓ Uloženo');
      if (failed) schedule(6000);
      if (again) { again = false; schedule(0); }
    }
  }

  // ---------- přihlášení / registrace (Google nebo e-mail + heslo) ----------
  const backUrl = () => location.origin + location.pathname;
  function openLogin(reason, startMode = 'login') {
    const root = $('#modalRoot');
    const st = { mode: startMode, name: '', email: '', pass: '', busy: false };
    const back = h('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) closeModal(); } });
    const modal = h('div', { class: 'modal narrow', role: 'dialog', 'aria-modal': 'true' });
    back.append(modal);
    root.innerHTML = '';
    root.append(back);

    const msg = (title, text) => {
      modal.innerHTML = '';
      modal.append(h('h2', {}, title), h('p', { class: 'sub' }, text),
        h('div', { class: 'modal-actions' }, h('span'), h('button', { class: 'btn primary', onclick: closeModal }, 'Jasně')));
    };

    const draw = () => {
      modal.innerHTML = '';
      const reg = st.mode === 'register', forgot = st.mode === 'forgot';
      const err = h('p', { class: 'form-err', role: 'alert' });
      const field = (label, attrs, key) => h('label', { class: 'field' }, h('span', {}, label),
        h('input', { ...attrs, value: st[key], oninput: e => (st[key] = e.target.value) }));
      const nameIn = field('Přezdívka', { maxlength: 40, required: true, autocomplete: 'nickname', placeholder: 'Jak ti říkat' }, 'name');
      const emailIn = field('E-mail', { type: 'email', required: true, autocomplete: 'email', placeholder: 'tvuj@email.cz' }, 'email');
      const passIn = field('Heslo', { type: 'password', required: true, minlength: 6, autocomplete: reg ? 'new-password' : 'current-password', placeholder: reg ? 'aspoň 6 znaků' : '' }, 'pass');

      // tlačítko od Googlu (přihlášení přímo na playalong.cz); když se nenačte, záložní přesměrování přes Supabase
      const gbox = h('div', { class: 'g-box' });
      if (!forgot) {
        const fallback = () => {
          gbox.innerHTML = '';
          gbox.append(h('button', {
            class: 'btn google-btn', type: 'button',
            onclick: async () => {
              const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: backUrl() } });
              if (error) err.textContent = 'Přihlášení přes Google teď nejde. Zkus e-mail.';
            },
          }, h('b', { class: 'g-logo' }, 'G'), 'Pokračovat přes Google'));
        };
        setTimeout(() => mountGoogleButton(gbox, () => { err.textContent = 'Přihlášení přes Google se nepovedlo. Zkus to znovu nebo e-mailem.'; }, reg)
          .catch(fallback), 0);
      }

      const submit = async e => {
        e.preventDefault();
        if (st.busy) return;
        st.busy = true; err.textContent = '';
        const email = st.email.trim();
        try {
          if (forgot) {
            const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: backUrl() });
            if (error) throw error;
            msg('Mrkni do e-mailu 📬', `Poslal jsem odkaz na nastavení hesla na ${email}. Otevři ho ve stejném prohlížeči.`);
          } else if (reg) {
            const name = st.name.trim().slice(0, 40);
            if (!name) { err.textContent = 'Napiš nějakou přezdívku.'; return; }
            let res;
            if (auth.anon) {
              // host (přidal songy bez účtu) → z anonymního účtu udělat normální, songy mu zůstanou
              res = await sb.auth.updateUser({ email, password: st.pass, data: { name, has_password: true } }, { emailRedirectTo: backUrl() });
            } else {
              res = await sb.auth.signUp({ email, password: st.pass, options: { data: { name, has_password: true }, emailRedirectTo: backUrl() } });
              if (!res.error && res.data?.user && !res.data.user.identities?.length) {
                err.textContent = 'Tenhle e-mail už je registrovaný. Přihlas se, nebo si nech poslat nové heslo.';
                return;
              }
            }
            if (res.error) throw res.error;
            if (res.data?.session && !auth.anon) { closeModal(); toast(`Vítej, ${name}! 🎸`); return; }
            msg('Potvrď registraci 📬', `Poslal jsem e-mail na ${email}. Klikni v něm na odkaz a budeš přihlášený.`);
          } else {
            const { error } = await sb.auth.signInWithPassword({ email, password: st.pass });
            if (error) throw error;
            closeModal();
            toast('Přihlášeno ✓');
          }
        } catch (ex) {
          const m = String(ex?.message || ex);
          err.textContent =
            /invalid login|invalid credentials/i.test(m) ? 'Špatný e-mail nebo heslo. Když ses dřív přihlašoval odkazem z e-mailu, heslo ještě nemáš – klikni na „Zapomenuté heslo“.'
            : /not confirmed/i.test(m) ? 'E-mail ještě není potvrzený. Klikni na odkaz, který ti přišel po registraci.'
            : /already|registered|exists/i.test(m) ? 'Tenhle e-mail už je registrovaný. Přihlas se, nebo si nech poslat nové heslo.'
            : /password/i.test(m) && /6|short|weak/i.test(m) ? 'Heslo je moc krátké nebo slabé (aspoň 6 znaků).'
            : /rate|seconds|too many/i.test(m) ? 'Moc pokusů za sebou. Zkus to za minutu.'
            : 'Něco se nepovedlo. Zkus to znovu.';
        } finally { st.busy = false; }
      };

      const link = (text, mode) => h('button', { class: 'linkish', type: 'button', onclick: () => { st.mode = mode; draw(); } }, text);
      modal.append(h('form', { onsubmit: submit },
        h('h2', {}, forgot ? 'Zapomenuté heslo' : reg ? 'Registrace' : 'Přihlásit se'),
        h('p', { class: 'sub' }, forgot ? 'Pošlu ti odkaz, kterým si nastavíš nové heslo.'
          : reason || (reg ? 'Účet potřebuješ, abys mohl přidávat a upravovat songy. Číst může kdokoli.'
            : 'Přihlášení potřebuješ, abys mohl přidávat a upravovat songy. Číst může kdokoli.')),
        !forgot && gbox,
        !forgot && h('p', { class: 'or' }, 'nebo e-mailem'),
        reg && nameIn,
        emailIn,
        !forgot && passIn,
        !reg && !forgot && h('p', { class: 'hint' }, link('Zapomenuté heslo?', 'forgot')),
        err,
        h('div', { class: 'modal-actions' },
          forgot ? link('← Zpět na přihlášení', 'login')
            : reg ? link('Už mám účet – přihlásit', 'login') : link('Nemám účet – registrace', 'register'),
          h('button', { class: 'btn primary', type: 'submit' }, forgot ? 'Poslat odkaz' : reg ? 'Zaregistrovat' : 'Přihlásit'))));
      setTimeout(() => modal.querySelector(reg ? 'input' : 'input[type=email]')?.focus(), 30);
    };
    draw();
  }

  /** po kliknutí na odkaz „nové heslo“ z e-mailu */
  function openNewPassword() {
    const root = $('#modalRoot');
    let pass = '';
    const err = h('p', { class: 'form-err', role: 'alert' });
    const back = h('div', { class: 'modal-back' });
    back.append(h('div', { class: 'modal narrow', role: 'dialog', 'aria-modal': 'true' },
      h('form', {
        onsubmit: async e => {
          e.preventDefault();
          if (pass.length < 6) { err.textContent = 'Aspoň 6 znaků.'; return; }
          const { error } = await sb.auth.updateUser({ password: pass, data: { has_password: true } });
          if (error) { err.textContent = 'Heslo se nepodařilo uložit. Zkus to znovu.'; return; }
          closeModal(); toast('Heslo nastavené ✓');
        },
      },
        h('h2', {}, 'Nové heslo'),
        h('p', { class: 'sub' }, 'Vymysli si heslo, kterým se budeš přihlašovat.'),
        h('label', { class: 'field' }, h('span', {}, 'Heslo'),
          h('input', { type: 'password', minlength: 6, required: true, autocomplete: 'new-password', placeholder: 'aspoň 6 znaků', oninput: e => (pass = e.target.value) })),
        err,
        h('div', { class: 'modal-actions' }, h('span'), h('button', { class: 'btn primary', type: 'submit' }, 'Uložit heslo')))));
    root.innerHTML = '';
    root.append(back);
  }

  // ---------- Google (Google Identity Services → Supabase signInWithIdToken) ----------
  let gsiLoading = null;
  function loadGsi() {
    if (window.google?.accounts?.id) return Promise.resolve();
    return gsiLoading || (gsiLoading = new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = ok; s.onerror = () => { gsiLoading = null; fail(new Error('gsi')); };
      document.head.append(s);
    }));
  }
  async function sha256hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function mountGoogleButton(box, onError, signup = false) {
    if (!cfg.googleClientId || !crypto?.subtle) throw new Error('google nejde');
    await loadGsi();
    const raw = crypto.randomUUID() + crypto.randomUUID();
    google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      nonce: await sha256hex(raw),
      callback: async r => {
        const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: r.credential, nonce: raw });
        if (error) { console.warn('Google', error); onError(error); return; }
        closeModal();
        toast('Přihlášeno přes Google ✓');
      },
    });
    box.innerHTML = '';
    google.accounts.id.renderButton(box, { theme: 'outline', size: 'large', shape: 'pill', text: signup ? 'signup_with' : 'continue_with', locale: 'cs', width: Math.min(360, box.clientWidth || 320) });
  }

  function openNameModal() {
    const root = $('#modalRoot');
    let name = auth.name || (auth.user?.email || '').split('@')[0].slice(0, 40);
    const input = h('input', { id: 'nickName', maxlength: 40, value: name, oninput: e => (name = e.target.value) });
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Uložit');
    const err = h('p', { class: 'form-err', role: 'alert' });
    const back = h('div', { class: 'modal-back' });
    back.append(h('div', { class: 'modal narrow', role: 'dialog', 'aria-modal': 'true' },
      h('form', {
        onsubmit: async e => {
          e.preventDefault();
          name = name.trim().slice(0, 40);
          if (!name) { err.textContent = 'Napiš nějakou přezdívku.'; return; }
          saveBtn.disabled = true; saveBtn.textContent = 'Ukládám…'; err.textContent = '';
          const timeout = new Promise(r => setTimeout(() => r({ error: { message: 'timeout' } }), 12000));
          const { error } = await Promise.race([sb.auth.updateUser({ data: { name } }), timeout]);
          saveBtn.disabled = false; saveBtn.textContent = 'Uložit';
          if (error) { err.textContent = 'Přezdívku se nepodařilo uložit. Zkus to znovu.'; return; }
          auth.name = name;
          closeModal(); render();
          toast(`Vítej, ${name}! 🎸`);
        },
      },
        h('h2', {}, 'Jak ti říkat?'),
        h('p', { class: 'sub' }, 'Tohle jméno uvidí ostatní u songů, které přidáš.'),
        h('label', { class: 'field' }, h('span', {}, 'Přezdívka'), input),
        err,
        h('div', { class: 'modal-actions' }, h('span'), saveBtn))));
    root.innerHTML = '';
    root.append(back);
    setTimeout(() => input.select(), 30);
  }

  // ---------- automatické časy (fronta) ----------
  const jobStatus = id => jobs.get(id) || null;
  const jobFit = id => fits.get(id) ?? null;

  /** zařadí song do fronty: pomocník stáhne YouTube a nechá spočítat časy na RunPodu */
  async function requestJob(id, ytId) {
    if (!auth.user) await signInAnon();
    // song musí být v databázi (nový se ukládá se zpožděním)
    schedule(0);
    for (let i = 0; i < 40 && !inDb.has(id); i++) await new Promise(r => setTimeout(r, 250));
    if (!inDb.has(id)) throw new Error('song není uložený');
    const { error } = await sb.from('jobs').insert({ song_id: id, yt: ytId });
    if (error && !/duplicate|unique/i.test(error.message)) throw error;
    jobs.set(id, 'queued');
  }

  /** zjistí, jestli je úloha hotová; když ano, načte písničku znovu (s časy) */
  async function checkJob(id) {
    const { data } = await sb.from('jobs').select('status, error').eq('song_id', id).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!data) { jobs.delete(id); return null; }
    if (data.status === 'queued' || data.status === 'working') { jobs.set(id, data.status); return data.status; }
    jobs.delete(id);
    if (data.status === 'done') {
      const i = songs.findIndex(x => x.id === id);
      if (i >= 0) { songs[i].partial = true; synced.delete(id); await ensureLoaded(id); }
    }
    return data.status;
  }

  /** stránka Nastavení účtu */
  function accountInfo() {
    const u = auth.user || {};
    const providers = (u.app_metadata?.providers || (u.app_metadata?.provider ? [u.app_metadata.provider] : []))
      .map(p => p === 'email' ? 'e-mail' : p === 'google' ? 'Google' : p);
    return { email: u.email || '', providers, hasPassword: !!u.user_metadata?.has_password };
  }
  async function saveName(name) {
    const timeout = new Promise(r => setTimeout(() => r({ error: { message: 'timeout' } }), 12000));
    const { error } = await Promise.race([sb.auth.updateUser({ data: { name } }), timeout]);
    if (error) return false;
    auth.name = name;
    return true;
  }
  async function setPassword(password) {
    const timeout = new Promise(r => setTimeout(() => r({ error: { message: 'timeout' } }), 12000));
    const { error } = await Promise.race([sb.auth.updateUser({ password, data: { has_password: true } }), timeout]);
    return !error;
  }

  /** značení akordů do nastavení účtu (ať platí na všech zařízeních) */
  function saveNotation(n) {
    setTimeout(() => { sb.auth.updateUser({ data: { notation: n } }).catch(() => { /* nic, zůstane aspoň v prohlížeči */ }); }, 0);
  }

  /** host bez e-mailu: anonymní účet, aby mohl přidat song (ten pak čeká na schválení) */
  async function signInAnon() {
    const { data, error } = await sb.auth.signInAnonymously();
    if (error) throw error;
    await loadUser(data.session);
    await reload({ quiet: true });
  }

  async function logout() {
    if (timer) { clearTimeout(timer); timer = 0; await flush(); }
    await sb.auth.signOut();
    toast('Odhlášeno');
  }

  /** songy, které byly dřív jen v tomhle prohlížeči → do zpěvníku pod mým jménem */
  function importLocal() {
    const list = auth.localOnly.filter(s => !songs.some(x => x.id === s.id));
    for (const s of list) { delete s.owner; s.isPublic = true; songs.push(s); }
    auth.localOnly = [];
    try { localStorage.removeItem(LS_SONGS); } catch { /* nic */ }
    schedule(0);
    render();
    toast(`Nahrávám ${list.length} songů do zpěvníku`);
  }

  return { init, schedule, openLogin, openNameModal, logout, signInAnon, saveNotation, accountInfo, saveName, setPassword, requestJob, checkJob, jobStatus, jobFit, importLocal, ensureLoaded, loadAll, approve };
})();
