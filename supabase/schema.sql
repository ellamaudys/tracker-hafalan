-- =====================================================================
-- SKEMA DATABASE TRACKER HAFALAN
-- Cara pakai: buka dashboard Supabase > SQL Editor > New query,
-- tempel seluruh isi file ini, lalu klik Run.
-- =====================================================================

-- Satu baris = satu ayat yang sudah dihafal oleh satu pengguna.
-- Ayat yang belum dihafal tidak punya baris.
create table if not exists public.hafalan (
  user_id          uuid     not null default auth.uid()
                            references auth.users (id) on delete cascade,
  surah            smallint not null check (surah between 1 and 114),
  ayat             smallint not null check (ayat >= 1),
  memorized_on     date     not null default current_date,  -- tanggal mulai hafal
  last_reviewed_on date     not null default current_date,  -- murajaah terakhir
  primary key (user_id, surah, ayat)
);

-- Row Level Security: setiap pengguna HANYA bisa melihat dan mengubah
-- barisnya sendiri. Ini yang membuat kunci publik di js/config.js aman.
alter table public.hafalan enable row level security;

drop policy if exists "hafalan_select_own" on public.hafalan;
drop policy if exists "hafalan_insert_own" on public.hafalan;
drop policy if exists "hafalan_update_own" on public.hafalan;
drop policy if exists "hafalan_delete_own" on public.hafalan;

create policy "hafalan_select_own" on public.hafalan
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "hafalan_insert_own" on public.hafalan
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "hafalan_update_own" on public.hafalan
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "hafalan_delete_own" on public.hafalan
  for delete to authenticated
  using ((select auth.uid()) = user_id);
