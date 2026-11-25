-- =========================================================
--  playalong.cz – databáze (Supabase / Postgres)
--  Spusť celé v Supabase: SQL Editor → New query → Run.
--
--  Pravidla:
--    • veřejné songy čte kdokoli (i nepřihlášený)
--    • přidávat smí jen přihlášený, song patří tomu, kdo ho přidal
--    • upravit / smazat smí autor nebo admin
--    • song „jen pro mě“ (is_public = false) vidí jen autor a admin
-- =========================================================

create table if not exists public.songs (
  id          text primary key check (id ~ '^[A-Za-z0-9]{1,40}$'),
  owner       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  author_name text not null default '' check (char_length(author_name) <= 60),
  title       text not null default '' check (char_length(title) <= 200),
  artist      text not null default '' check (char_length(artist) <= 200),
  data        jsonb not null,                       -- tónina, kapo, řádky, akordy
  is_public   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint songs_data_size check (pg_column_size(data) < 200000)
);

create index if not exists songs_updated_idx on public.songs (updated_at desc);

create table if not exists public.admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);

-- je přihlášený uživatel admin?
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- updated_at se nastavuje sám
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists songs_touch on public.songs;
create trigger songs_touch before update on public.songs
  for each row execute function public.touch_updated_at();

-- vlastníka songu nejde změnit (ani adminem)
create or replace function public.keep_owner()
returns trigger language plpgsql as $$
begin
  new.owner := old.owner;
  new.id := old.id;
  return new;
end $$;

drop trigger if exists songs_keep_owner on public.songs;
create trigger songs_keep_owner before update on public.songs
  for each row execute function public.keep_owner();

-- ---------- Row Level Security ----------
alter table public.songs  enable row level security;
alter table public.admins enable row level security;

drop policy if exists "songs: číst veřejné a svoje" on public.songs;
create policy "songs: číst veřejné a svoje" on public.songs
  for select using (is_public or owner = auth.uid() or public.is_admin());

drop policy if exists "songs: přidat jako já" on public.songs;
create policy "songs: přidat jako já" on public.songs
  for insert to authenticated with check (owner = auth.uid());

drop policy if exists "songs: upravit svoje nebo admin" on public.songs;
create policy "songs: upravit svoje nebo admin" on public.songs
  for update to authenticated
  using (owner = auth.uid() or public.is_admin())
  with check (owner = auth.uid() or public.is_admin());

drop policy if exists "songs: smazat svoje nebo admin" on public.songs;
create policy "songs: smazat svoje nebo admin" on public.songs
  for delete to authenticated
  using (owner = auth.uid() or public.is_admin());

drop policy if exists "admins: vidím jen sebe" on public.admins;
create policy "admins: vidím jen sebe" on public.admins
  for select to authenticated using (user_id = auth.uid());
-- do tabulky admins se zapisuje jen ručně v SQL Editoru (viz README)

grant select on public.songs to anon, authenticated;
grant insert, update, delete on public.songs to authenticated;
grant select on public.admins to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- Schvalování (přidáno později) ----------
--  • nové songy od ostatních vidí jen autor a admin, dokud je admin neschválí
--  • upravit/smazat: admin vždy, autor jen svůj neschválený song
--  • schválit smí jen admin (hlídá trigger), song od admina je schválený hned
alter table public.songs add column if not exists approved boolean not null default false;

create or replace function public.guard_approved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_admin() then
    if tg_op = 'INSERT' then new.approved := true; end if;
  else
    if tg_op = 'INSERT' then new.approved := false; else new.approved := old.approved; end if;
  end if;
  return new;
end $$;

drop trigger if exists songs_guard_approved on public.songs;
create trigger songs_guard_approved before insert or update on public.songs
  for each row execute function public.guard_approved();

drop policy if exists "songs: číst veřejné a svoje" on public.songs;
create policy "songs: číst veřejné a svoje" on public.songs
  for select using ((is_public and approved) or owner = auth.uid() or public.is_admin());

drop policy if exists "songs: upravit svoje nebo admin" on public.songs;
create policy "songs: upravit svoje nebo admin" on public.songs
  for update to authenticated
  using (public.is_admin() or (owner = auth.uid() and not approved))
  with check (public.is_admin() or (owner = auth.uid() and not approved));

drop policy if exists "songs: smazat svoje nebo admin" on public.songs;
create policy "songs: smazat svoje nebo admin" on public.songs
  for delete to authenticated
  using (public.is_admin() or (owner = auth.uid() and not approved));
