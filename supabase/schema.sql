-- Schema Supabase untuk auto-verify liveness Binance P2P.
-- Jalankan sekali di Supabase → SQL Editor → New query → Run. Aman dijalankan ulang.
--
-- Dipakai oleh src/auto-verify/adapters/supabase-kv.ts (tabel key/value). Kunci yang disimpan:
--   auto_verify_settings          → {"enabled": true|false}
--   auto_verify_liveness_records  → record liveness per nomor order (maks 100 terbaru)

create table if not exists public.user_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

-- upsert() tidak mengubah updated_at dengan sendirinya: perbarui lewat trigger.
create or replace function public.user_settings_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists user_settings_touch_updated_at on public.user_settings;
create trigger user_settings_touch_updated_at
  before update on public.user_settings
  for each row execute function public.user_settings_touch_updated_at();

-- RLS aktif TANPA policy: anon/authenticated key (yang bisa terlihat di browser) tidak bisa
-- membaca/menulis apa pun. Server memakai SUPABASE_SERVICE_ROLE_KEY, yang melewati RLS.
alter table public.user_settings enable row level security;
revoke all on public.user_settings from anon, authenticated;
