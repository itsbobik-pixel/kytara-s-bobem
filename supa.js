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

  const synced = new Map();   // id → JSON uloženého stavu (jen songy, které smím upravit)
  const inDb = new Set();     // id songů, které už v databázi existují
  let timer = 0, flushing = false, again = false;

  const payload = s => ({
    title: (s.title || '').slice(0, 200),
    artist: (s.artist || '').slice(0, 200),
    is_public: s.isPublic !== false,
    data: { key: s.key, baseKey: s.baseKey || null, capo: s.capo || 0, lines: s.lines, custom: s.custom || [], sync: s.sync || null },
  });
  const fromRow = r => ({
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
  });

  async function fetchSongs() {
    const { data, error } = await sb.from('songs')
      .select('id, owner, author_name, title, artist, data, is_public, updated_at')
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (error) throw error;
    return data.map(fromRow);
  }

  function rememberSynced(list) {
    synced.clear(); inDb.clear();
    for (const s of list) {
      inDb.add(s.id);
      if (canEdit(s)) synced.set(s.id, JSON.stringify(payload(s)));
    }
  }

  async function loadUser(session) {
    const user = session?.user || null;
    auth.user = user;
    auth.admin = false;
    auth.name = user?.user_metadata?.name || '';
    if (user) {
      const { data } = await sb.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
      auth.admin = !!data;
    }
  }

  async function reload({ quiet = false } = {}) {
    try {
      const list = await fetchSongs();
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
    if (auth.user && !auth.name) openNameModal();

    // Pozor: uvnitř onAuthStateChange se nesmí čekat na další volání Supabase (zasekne se zámek
    // přihlášení a např. updateUser nikdy nedoběhne) → práci odložíme mimo callback.
    sb.auth.onAuthStateChange((event, sess) => {
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
        if (!canEdit(s)) continue;
        const p = payload(s);
        const json = JSON.stringify(p);
        if (synced.get(s.id) === json) continue;
        let res;
        if (inDb.has(s.id)) {
          res = await sb.from('songs').update(p).eq('id', s.id).select('updated_at').maybeSingle();
        } else {
          res = await sb.from('songs').insert({ id: s.id, author_name: auth.name || 'Kytarista', ...p })
            .select('owner, author_name, updated_at').single();
          if (!res.error) { inDb.add(s.id); s.owner = res.data.owner; s.author = res.data.author_name; }
        }
        if (res.error) { failed = true; console.warn('Uložení selhalo', s.id, res.error.message); continue; }
        synced.set(s.id, json);
      }
      for (const id of [...synced.keys()]) {
        if (ids.has(id)) continue;
        const { error } = await sb.from('songs').delete().eq('id', id);
        if (error) { failed = true; continue; }
        synced.delete(id); inDb.delete(id);
      }
    } finally {
      flushing = false;
      setStatus(failed ? '⚠ Něco se neuložilo, zkouším znovu' : '✓ Uloženo');
      if (failed) schedule(6000);
      if (again) { again = false; schedule(0); }
    }
  }

  // ---------- přihlášení ----------
  function openLogin(reason) {
    const root = $('#modalRoot');
    const st = { email: '', sent: false, busy: false };
    const back = h('div', { class: 'modal-back', onpointerdown: e => { if (e.target === back) closeModal(); } });
    const modal = h('div', { class: 'modal narrow', role: 'dialog', 'aria-modal': 'true' });
    back.append(modal);
    root.innerHTML = '';
    root.append(back);

    const draw = () => {
      modal.innerHTML = '';
      if (st.sent) {
        modal.append(
          h('h2', {}, 'Mrkni do e-mailu 📬'),
          h('p', { class: 'sub' }, `Poslal jsem odkaz na ${st.email}. Otevři ho ve stejném prohlížeči a budeš přihlášený.`),
          h('div', { class: 'modal-actions' }, h('span'), h('button', { class: 'btn primary', onclick: closeModal }, 'Jasně')));
        return;
      }
      const input = h('input', { id: 'loginEmail', type: 'email', required: true, autocomplete: 'email', placeholder: 'tvuj@email.cz', value: st.email, oninput: e => (st.email = e.target.value) });
      const err = h('p', { class: 'form-err', role: 'alert' });
      modal.append(h('form', {
        onsubmit: async e => {
          e.preventDefault();
          if (st.busy) return;
          st.busy = true;
          const { error } = await sb.auth.signInWithOtp({
            email: st.email.trim(),
            options: { emailRedirectTo: location.origin + location.pathname },
          });
          st.busy = false;
          if (error) {
            err.textContent = /rate|seconds/i.test(error.message)
              ? 'Moc pokusů za sebou. Zkus to za minutu.'
              : 'Odkaz se nepodařilo poslat. Zkontroluj e-mail a zkus to znovu.';
            return;
          }
          st.sent = true; draw();
        },
      },
        h('h2', {}, 'Přihlásit se'),
        h('p', { class: 'sub' }, reason || 'Přihlášení potřebuješ, abys mohl přidávat a upravovat songy. Číst může kdokoli.'),
        h('label', { class: 'field' }, h('span', {}, 'E-mail'), input),
        h('p', { class: 'hint' }, 'Žádné heslo: pošlu ti odkaz, kterým se přihlásíš.'),
        err,
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn ghost', type: 'button', onclick: closeModal }, 'Zrušit'),
          h('button', { class: 'btn primary', type: 'submit' }, 'Poslat odkaz'))));
      setTimeout(() => input.focus(), 30);
    };
    draw();
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

  return { init, schedule, openLogin, openNameModal, logout, importLocal };
})();
